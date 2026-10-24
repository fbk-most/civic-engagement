"""Per-building height from PAT's 2014 LiDAR survey, in preference to the
OSM tag cascade in buildings.py's `building_heights` — see BuildingDefaults
(buildings.py) for the thresholds. Why it exists: checked against
the OSM-derived heights, LiDAR reads a median 3.5m taller across Piazza
Dante's 62 buildings, which is a systematic gap (storey-height guesses
undercounting real attics/parapets), not noise.

DBM ("Digital Building Model") is PAT's own DSM already filtered to
buildings, but it's still absolute elevation, not height above ground — the
nDSM (`DBM - DTM`) is what's actually usable per footprint.
"""

from dataclasses import dataclass

import numpy as np
from shapely.geometry.base import BaseGeometry

from civic_engagement.config import SITE
from civic_engagement.ingestion.raster import Grid, load_asc, sample_polygon, sample_polygon_xy


@dataclass
class BuildingLidarStats:
    # Used as the wall/eave height for every building, flat or pitched: robust
    # to a chimney/antenna/parapet pulling the true max up past what a
    # facilitator would call the building's height. (p10 was tried as a
    # lower, more eave-like statistic for pitched roofs specifically, and
    # rejected — see BuildingDefaults.roof_min_rise_m/
    # roof_max_rise_m for why: it just as easily dips into an unrelated low
    # area inside the same footprint, e.g. a courtyard, giving absurd rises.)
    height_p90: float
    height_max: float  # ridge candidate — see roofs.ts
    height_std: float  # spread across the footprint — see BuildingDefaults.roof_pitch_std_threshold_m
    # The roof's own samples, those above ROOF_MIN_M (an OSM footprint often
    # overhangs the ground beside the building, in the LiDAR): their share
    # of the footprint, and a low and a high percentile of them, the eave's
    # and the ridge's heights for a pitched roof (see BuildingDefaults.
    # roof_samples). NaN without any.
    roof_share: float = 0.0
    roof_low: float = float("nan")
    roof_high: float = float("nan")


@dataclass
class RoofForm:
    """A pitched roof's shape, as read off its samples (see `roof_form`):
    gabled or hipped, and its ridge's direction, a unit vector in the grid's
    CRS."""

    shape: str
    ridge: tuple[float, float]


# Above the ground by this much, a sample is the building's.
ROOF_MIN_M = 1.5
# A hipped roof must fit the samples this much better than a gabled one (its
# error a fraction of the gabled's): a gable is the valleys' common roof.
# From Bocenago's, checked on the orthophoto: between 0.95 and 1, as many
# gables as hips; below, mostly hips.
HIP_FIT = 0.95
# Fewer roof samples than this, and the roof's form isn't read.
FORM_MIN_SAMPLES = 12


class LidarHeightModel:
    """Loads both grids once; `None` values on either path mean "not
    downloaded", which buildings.py treats as "fall back to OSM tags"
    rather than an error — see SiteConfig.lidar_dbm_path's docstring in
    config.py.
    """

    def __init__(self, dbm: Grid, dtm: Grid):
        self._dbm = dbm
        self._dtm = dtm

    @classmethod
    def load(
        cls, dbm_path: str | None = None, dtm_path: str | None = None
    ) -> "LidarHeightModel | None":
        """From the given files, the active site's by default."""
        dbm_path = dbm_path or SITE.lidar_dbm_path
        dtm_path = dtm_path or SITE.lidar_dtm_path
        try:
            return cls(load_asc(dbm_path), load_asc(dtm_path))
        except FileNotFoundError:
            return None

    def sample(self, polygon_utm: BaseGeometry) -> BuildingLidarStats | None:
        dbm_vals = sample_polygon(polygon_utm, self._dbm)
        dtm_vals = sample_polygon(polygon_utm, self._dtm)
        if dbm_vals.size == 0 or dtm_vals.size != dbm_vals.size:
            return None
        ndsm = dbm_vals - dtm_vals
        ndsm = ndsm[~np.isnan(ndsm)]
        if ndsm.size < 4:
            return None
        roof = ndsm[ndsm > ROOF_MIN_M]
        return BuildingLidarStats(
            height_p90=float(np.percentile(ndsm, 90)),
            height_max=float(ndsm.max()),
            height_std=float(ndsm.std()),
            roof_share=roof.size / ndsm.size,
            roof_low=float(np.percentile(roof, 15)) if roof.size else float("nan"),
            roof_high=float(np.percentile(roof, 95)) if roof.size else float("nan"),
        )

    def roof_form(self, polygon_utm: BaseGeometry) -> RoofForm | None:
        """The roof's form, from how its samples fall across the footprint's
        rectangle (its minimum rotated one): each candidate, a roof sloping
        evenly away from a ridge, is fit to the samples' heights (least
        squares, the eave's height and the pitch free), and the closest
        wins. A gable with its ridge along the rectangle's long side or across
        it (the valleys' houses often have their gable on the long side), or
        hipped (its ends sloping like its sides; with the ridge along the
        long side). None if too few samples."""
        dbm, x, y = sample_polygon_xy(polygon_utm, self._dbm)
        dtm = sample_polygon(polygon_utm, self._dtm)
        if dbm.size == 0 or dtm.size != dbm.size:
            return None
        height = dbm - dtm
        roof = ~np.isnan(height) & (height > ROOF_MIN_M)
        if roof.sum() < FORM_MIN_SAMPLES:
            return None
        height, x, y = height[roof], x[roof], y[roof]

        rect = polygon_utm.minimum_rotated_rectangle
        corners = np.array(rect.exterior.coords[:3])
        long_side, short_side = corners[1] - corners[0], corners[2] - corners[1]
        if np.hypot(*long_side) < np.hypot(*short_side):
            long_side, short_side = short_side, long_side
        length, width = np.hypot(*long_side), np.hypot(*short_side)
        along, across = long_side / length, short_side / width
        dx, dy = x - rect.centroid.x, y - rect.centroid.y
        u = np.abs(dx * along[0] + dy * along[1])  # from the middle, along
        w = np.abs(dx * across[0] + dy * across[1])  # and across

        def error(distance: np.ndarray) -> float:
            """How far the heights are from a roof falling evenly with the
            distance from its ridge."""
            a = np.c_[np.ones_like(distance), distance]
            fit, *_ = np.linalg.lstsq(a, height, rcond=None)
            return float(np.sqrt(np.mean((height - a @ fit) ** 2)))

        gable_along = error(w)
        gable_across = error(u)
        hipped = error(np.maximum(w, u - (length - width) / 2))
        if hipped < HIP_FIT * min(gable_along, gable_across):
            return RoofForm("hipped", (float(along[0]), float(along[1])))
        ridge = along if gable_along <= gable_across else across
        return RoofForm("gabled", (float(ridge[0]), float(ridge[1])))
