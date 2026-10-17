"""Per-building height from PAT's 2014 LiDAR survey, in preference to the
OSM tag cascade in osm.py's `building_heights` — see the module docstring on
SiteConfig.roof_pitch_std_threshold_m for why this exists: checked against
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
from civic_engagement.ingestion.raster import Grid, load_asc, sample_polygon


@dataclass
class BuildingLidarStats:
    # Used as the wall/eave height for every building, flat or pitched: robust
    # to a chimney/antenna/parapet pulling the true max up past what a
    # facilitator would call the building's height. (p10 was tried as a
    # lower, more eave-like statistic for pitched roofs specifically, and
    # rejected — see build_baseline.py's comment on SiteConfig.roof_min_rise_m/
    # roof_max_rise_m for why: it just as easily dips into an unrelated low
    # area inside the same footprint, e.g. a courtyard, giving absurd rises.)
    height_p90: float
    height_max: float  # ridge candidate — see roofs.ts
    height_std: float  # spread across the footprint — see SiteConfig.roof_pitch_std_threshold_m


class LidarHeightModel:
    """Loads both grids once; `None` values on either path mean "not
    downloaded", which build_baseline.py treats as "fall back to OSM tags"
    rather than an error — see SiteConfig.lidar_dbm_path's docstring in
    config.py.
    """

    def __init__(self, dbm: Grid, dtm: Grid):
        self._dbm = dbm
        self._dtm = dtm

    @classmethod
    def load(
        cls, dbm_path: str = SITE.lidar_dbm_path, dtm_path: str = SITE.lidar_dtm_path
    ) -> "LidarHeightModel | None":
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
        return BuildingLidarStats(
            height_p90=float(np.percentile(ndsm, 90)),
            height_max=float(ndsm.max()),
            height_std=float(ndsm.std()),
        )
