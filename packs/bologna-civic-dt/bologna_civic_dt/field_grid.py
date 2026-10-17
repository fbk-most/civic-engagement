"""The scene at a given year as rasters for the felt-temperature field
(thermal_field.py): what casts shade, and what the ground is made of.

Two grids, aligned cell for cell (FIELD_CELL_M):
- the *field grid* covers the site boundary's bounding box — felt
  temperature is computed and shown there, inside the boundary and outside
  buildings (`open`);
- the *occluder grid* is the field grid plus a margin all round
  (the site's building fetch buffer), so buildings and trees just outside
  the site still cast their shade on it.

Coordinates are the 3D view's local metric frame (frontend/src/three/geo.ts:
an equirectangular tangent plane at the mean of the boundary ring's
vertices), with x east and y north. Unlike UTM, its axes point at true
north, which is what the sun's azimuth is measured from — and it is the
frame the frontend draws the field in, without any reprojection.
"""

import math
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
import shapely
from shapely.geometry import Point
from shapely.geometry.base import BaseGeometry

from bologna_civic_dt.sites import SITE
from bologna_civic_dt.parameters import (
    COVER_SURFACE,
    CROWN_BASE_FRACTION,
    CROWN_BASE_FRACTION_EVERGREEN,
    DEFAULT_SURFACE,
    FIELD_CELL_M,
    MATERIAL_SURFACE,
    PERGOLA_SLAB_M,
    SURFACES,
)
from civic_engagement.local_frame import Anchor
from civic_engagement.models.schema import CoverPolygon, DiscreteElement

# Pergolas (frontend builders/furniture.ts: side and roof height by size)
# and the kiosk's body, as discs of the same area.
PERGOLA_SIZE = {"small": (3.0, 2.4), "medium": (4.0, 2.6), "large": (5.0, 2.8)}
KIOSK_RADIUS_M = 1.2
KIOSK_HEIGHT_M = 2.3


# --- the local frame -------------------------------------------------------------------


@dataclass(frozen=True)
class Frame:
    """A grid of square cells: column i, row j has its centre at
    (x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell); row 0 is the southern
    edge."""

    x0: float
    y0: float
    nx: int
    ny: int
    cell: float = FIELD_CELL_M

    def centres(self) -> tuple[np.ndarray, np.ndarray]:
        return _centres(self)

    def window(self, geometry: BaseGeometry, pad: float = 0.0) -> tuple[slice, slice]:
        minx, miny, maxx, maxy = geometry.bounds
        i0 = max(math.floor((minx - pad - self.x0) / self.cell), 0)
        i1 = min(math.ceil((maxx + pad - self.x0) / self.cell) + 1, self.nx)
        j0 = max(math.floor((miny - pad - self.y0) / self.cell), 0)
        j1 = min(math.ceil((maxy + pad - self.y0) / self.cell) + 1, self.ny)
        return slice(j0, max(j0, j1)), slice(i0, max(i0, i1))


@lru_cache(maxsize=8)
def _centres(frame: Frame) -> tuple[np.ndarray, np.ndarray]:
    xs = frame.x0 + (np.arange(frame.nx) + 0.5) * frame.cell
    ys = frame.y0 + (np.arange(frame.ny) + 0.5) * frame.cell
    return np.meshgrid(xs, ys)


def frames(boundary: BaseGeometry, margin_m: float) -> tuple[Frame, Frame]:
    """The field grid over the boundary's bounding box, and the occluder
    grid around it."""
    minx, miny, maxx, maxy = boundary.bounds
    x0, y0 = math.floor(minx / FIELD_CELL_M) * FIELD_CELL_M, math.floor(miny / FIELD_CELL_M) * FIELD_CELL_M
    nx = math.ceil((maxx - x0) / FIELD_CELL_M)
    ny = math.ceil((maxy - y0) / FIELD_CELL_M)
    m = math.ceil(margin_m / FIELD_CELL_M)
    field = Frame(x0, y0, nx, ny)
    occluders = Frame(x0 - m * FIELD_CELL_M, y0 - m * FIELD_CELL_M, nx + 2 * m, ny + 2 * m)
    return field, occluders


def _inside(frame: Frame, geometry: BaseGeometry, pad: float = 0.0) -> tuple[tuple[slice, slice], np.ndarray]:
    """The window of `frame` around `geometry`, and which of its cell
    centres fall inside it."""
    window = frame.window(geometry, pad)
    xs, ys = frame.centres()
    return window, shapely.contains_xy(geometry, xs[window], ys[window])


# --- the rasters -------------------------------------------------------------------------


@dataclass
class FieldRasters:
    anchor: Anchor
    field: Frame
    occluders: Frame
    # On the field grid:
    open: np.ndarray  # 1 inside the site and outside buildings
    surface: np.ndarray  # (surface, y, x), one-hot
    canopy_deciduous: np.ndarray  # 1 under a deciduous crown
    canopy_evergreen: np.ndarray  # 1 under an evergreen crown
    water_distance: np.ndarray  # m to the nearest water cover (0 on it)
    fountain_distance: np.ndarray  # m to the nearest fountain
    # On the occluder grid:
    building_height: np.ndarray  # m, 0 where there is no building
    crown_low: np.ndarray  # bottom and top of whatever filters the sun, m
    crown_high: np.ndarray  # (crown_low == crown_high: nothing)
    deciduous: np.ndarray  # what filters the sun: 1 where it is a deciduous crown,
    evergreen: np.ndarray  # an evergreen crown,
    pergola: np.ndarray  # a pergola roof


def _merge_band(r: dict, window, inside: np.ndarray, low, high) -> None:
    """Widen each cell's filtering band to include [low, high]."""
    lo, hi = r["crown_low"][window], r["crown_high"][window]
    empty = lo >= hi
    lo[inside] = np.where(empty, low, np.minimum(lo, low))[inside]
    hi[inside] = np.where(empty, high, np.maximum(hi, high))[inside]


def _paint_band(r: dict, frame: Frame, area: BaseGeometry, low: float, high: float, kind: str) -> None:
    """A flat slab between `low` and `high` over `area`."""
    window, inside = _inside(frame, area)
    _merge_band(r, window, inside, low, high)
    r[kind][window][inside] = 1.0


def _paint_crown(r: dict, frame: Frame, centre: Point, radius: float, low: float, high: float, kind: str) -> None:
    """An ellipsoid between `low` and `high`, `radius` wide: each cell gets
    the vertical extent of the ellipsoid above its centre."""
    disc = centre.buffer(radius, quad_segs=8)
    window, inside = _inside(frame, disc)
    if not inside.any():
        return
    xs, ys = frame.centres()
    d2 = ((xs[window] - centre.x) ** 2 + (ys[window] - centre.y) ** 2) / radius**2
    half = (high - low) / 2 * np.sqrt(np.clip(1 - d2, 0, 1))
    mid = (low + high) / 2
    _merge_band(r, window, inside, mid - half, mid + half)
    r[kind][window][inside] = 1.0


# Stands for "no water anywhere": far enough for any cooling to vanish.
FAR_M = 1e4


def _distance(xs: np.ndarray, ys: np.ndarray, geometries: list[BaseGeometry]) -> np.ndarray:
    """Per cell centre: metres to the nearest of `geometries` (0 inside)."""
    if not geometries:
        return np.full(xs.shape, FAR_M)
    return shapely.distance(shapely.union_all(geometries), shapely.points(xs, ys))


def rasterize(boundary_geojson: dict, elements: list[DiscreteElement], covers: list[CoverPolygon]) -> FieldRasters:
    """The rasters of a scene (elements and covers as served for one year)."""
    anchor = Anchor.of(boundary_geojson)
    boundary = anchor.local(boundary_geojson)
    field, occluders = frames(boundary, SITE.building_fetch_buffer_m)

    occ = {name: np.zeros((occluders.ny, occluders.nx)) for name in (
        "building_height", "crown_low", "crown_high", "deciduous", "evergreen", "pergola",
    )}
    surface = np.full((field.ny, field.nx), SURFACES.index(DEFAULT_SURFACE))
    canopy = {"deciduous": np.zeros((field.ny, field.nx)), "evergreen": np.zeros((field.ny, field.nx))}

    def paint_surface(geometry: BaseGeometry, name: str) -> None:
        window, inside = _inside(field, geometry)
        surface[window][inside] = SURFACES.index(name)

    def paint_lines(element: DiscreteElement) -> None:
        width = float(element.properties.get("width") or 2.0)
        material = element.properties.get("material") or ""
        paint_surface(anchor.local(element.geometry).buffer(width / 2), MATERIAL_SURFACE.get(material, "stone"))

    for cover in covers:
        if cover.source == "baseline":
            paint_surface(anchor.local(cover.geometry), COVER_SURFACE.get(cover.cover_type, DEFAULT_SURFACE))
    for kind in ("street", "path"):
        for element in elements:
            if element.type == kind and element.source == "baseline":
                paint_lines(element)
    # Interventions last, in the order they were placed.
    for cover in covers:
        if cover.source == "intervention":
            paint_surface(anchor.local(cover.geometry), COVER_SURFACE.get(cover.cover_type, DEFAULT_SURFACE))
    for element in elements:
        if element.type == "path" and element.source == "intervention":
            paint_lines(element)

    buildings = np.zeros((field.ny, field.nx), dtype=bool)
    for element in elements:
        geometry = element.geometry
        if element.type == "building":
            footprint = anchor.local(geometry)
            window, inside = _inside(occluders, footprint)
            height = float(element.properties.get("height") or SITE.default_building_height_m)
            target = occ["building_height"][window]
            target[inside] = np.maximum(target[inside], height)
            fwindow, finside = _inside(field, footprint)
            buildings[fwindow] |= finside
        elif element.type == "kiosk":
            disc = anchor.local(geometry).buffer(KIOSK_RADIUS_M)
            window, inside = _inside(occluders, disc)
            occ["building_height"][window][inside] = np.maximum(occ["building_height"][window][inside], KIOSK_HEIGHT_M)
        elif element.type == "pergola":
            side, roof = PERGOLA_SIZE.get(element.properties.get("size", "medium"), PERGOLA_SIZE["medium"])
            disc = anchor.local(geometry).buffer(side / math.sqrt(math.pi), quad_segs=8)
            _paint_band(occ, occluders, disc, roof - PERGOLA_SLAB_M / 2, roof + PERGOLA_SLAB_M / 2, "pergola")
        elif element.type == "tree":
            props = element.properties
            diameter = float(props.get("canopy_diameter") or 0.0)
            height = float(props.get("height") or 0.0)
            if props.get("status") == "stump" or diameter <= 0 or height <= 0:
                continue
            evergreen = props.get("foliage_type") == "evergreen"
            base = CROWN_BASE_FRACTION_EVERGREEN if evergreen else CROWN_BASE_FRACTION
            low = max(height * base, 0.3)
            centre = anchor.local(geometry)
            kind = "evergreen" if evergreen else "deciduous"
            _paint_crown(occ, occluders, centre, diameter / 2, low, height, kind)
            window, inside = _inside(field, centre.buffer(diameter / 2, quad_segs=8))
            canopy[kind][window][inside] = 1.0

    xs, ys = field.centres()
    in_site = shapely.contains_xy(boundary, xs, ys)
    water = [anchor.local(c.geometry) for c in covers if c.cover_type == "water"]
    fountains = [anchor.local(e.geometry) for e in elements if e.type == "water_feature"]
    one_hot = (surface[None, :, :] == np.arange(len(SURFACES))[:, None, None]).astype(float)
    return FieldRasters(
        anchor=anchor,
        field=field,
        occluders=occluders,
        open=(in_site & ~buildings).astype(float),
        surface=one_hot,
        canopy_deciduous=canopy["deciduous"],
        canopy_evergreen=canopy["evergreen"],
        water_distance=_distance(xs, ys, water),
        fountain_distance=_distance(xs, ys, fountains),
        **occ,
    )
