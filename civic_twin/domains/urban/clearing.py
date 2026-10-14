"""What a clearing takes away: the first half of a "coltiva il terreno" card,
which removes what stands on its area before it turns the ground over.

This module only *looks*: given a layout, an area and a year, `analyse` says
what would be cleared, what blocks the clearing and which covers it would
replace. It changes nothing. It is the single place those rules live, so the
check shown to the user before placing a card and the clearing that is then
applied cannot disagree.

What counts, in short (the tables are in `parameters.py`):

- only what exists at the year of the card is looked at: from its `start` up
  to its `end`, if a clearing has already ended it;
- clearable objects inside the area are cleared; a path crossing its edge is
  cut there, and what lies outside stays;
- protected objects (buildings, streets...) under the area block it;
- every cover under the area is replaced; some need a warning first.

Everything is measured in the projected CRS, in metres.
"""

from collections import Counter
from dataclasses import dataclass, field

import geopandas as gpd
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from civic_twin.config import PROJECTED_CRS, WGS84_CRS
from civic_twin.domains.urban.layout import Entry, Layout
from civic_twin.domains.urban.parameters import (
    CLEARABLE_ELEMENT_TYPES,
    CLEARED_COVER_WARNING_TYPES,
    PROTECTED_ELEMENT_TYPES,
)
from civic_twin.geo_utils import to_projected

# An overlap smaller than this is two shapes touching, not one on the other.
MIN_OVERLAP_M2 = 0.5
# A length of path, or of a line-shaped protected object, that counts as inside.
MIN_OVERLAP_LENGTH_M = 0.5
# Width of a street whose width is not known, and of a marking's.
DEFAULT_STREET_WIDTH_M = 6.0
DEFAULT_MARKING_WIDTH_M = 0.5

LINES = ("LineString", "MultiLineString")
AREAS = ("Polygon", "MultiPolygon")


@dataclass(frozen=True)
class ClearedElement:
    entry: int  # index into Layout.entries
    type: str  # the element's type; "tree" for a tree
    # A path only: what is left of it outside the area (projected), or None
    # if nothing worth keeping is.
    remainder: BaseGeometry | None = None


@dataclass(frozen=True)
class BlockingElement:
    entry: int
    id: str
    type: str


@dataclass(frozen=True)
class CoveredArea:
    entry: int
    cover_type: str
    region: BaseGeometry  # the part of that cover under the area (projected)
    needs_warning: bool


@dataclass
class ClearingReport:
    elements: list[ClearedElement] = field(default_factory=list)
    blocking: list[BlockingElement] = field(default_factory=list)
    covers: list[CoveredArea] = field(default_factory=list)

    @property
    def elements_by_type(self) -> dict[str, int]:
        return dict(Counter(cleared.type for cleared in self.elements))

    @property
    def cover_area_by_type(self) -> dict[str, float]:
        areas: Counter = Counter()
        for covered in self.covers:
            areas[covered.cover_type] += covered.region.area
        return dict(areas)


def project(geometries: list[dict]) -> list[BaseGeometry]:
    """GeoJSON geometries (WGS84) in the projected CRS, all in one conversion."""
    if not geometries:
        return []
    return list(gpd.GeoSeries([shape(g) for g in geometries], crs=WGS84_CRS).to_crs(PROJECTED_CRS))


def to_wgs84(geometry: BaseGeometry) -> dict:
    """A projected geometry as GeoJSON (WGS84)."""
    return mapping(gpd.GeoSeries([geometry], crs=PROJECTED_CRS).to_crs(WGS84_CRS).iloc[0])


def polygonal(geometry: BaseGeometry) -> BaseGeometry | None:
    """Just the area-bearing part of a geometry (a difference or an
    intersection can leave stray lines and points), or None if there is none."""
    if geometry.is_empty:
        return None
    if isinstance(geometry, (Polygon, MultiPolygon)):
        return geometry if geometry.area > 0 else None
    if isinstance(geometry, GeometryCollection):
        parts = [g for g in geometry.geoms if isinstance(g, (Polygon, MultiPolygon)) and g.area > 0]
        return unary_union(parts) if parts else None
    return None


def exists_at(entry: Entry, year: int) -> bool:
    return entry.start <= year and (entry.end is None or year < entry.end)


def _owner(layout: Layout, entry: Entry) -> str | None:
    if entry.element is not None:
        return entry.element.intervention_id
    if entry.cover is not None:
        return entry.cover.intervention_id
    return layout.trees[entry.tree].intervention_id


def _kind_and_geometry(layout: Layout, entry: Entry) -> tuple[str, dict]:
    if entry.element is not None:
        return entry.element.type, entry.element.geometry
    if entry.cover is not None:
        return "cover", entry.cover.geometry
    return "tree", layout.trees[entry.tree].geometry


def _blocks(element_type: str, properties: dict, geometry: BaseGeometry, area: BaseGeometry) -> bool:
    """Whether a protected object is under the area."""
    if geometry.geom_type in LINES:
        # A street or a marking is a line with a width.
        default = DEFAULT_STREET_WIDTH_M if element_type == "street" else DEFAULT_MARKING_WIDTH_M
        width = float(properties.get("width") or default)
        ribbon = geometry.buffer(width / 2)
        return (
            ribbon.intersection(area).area > MIN_OVERLAP_M2
            or geometry.intersection(area).length >= MIN_OVERLAP_LENGTH_M
        )
    if geometry.geom_type in AREAS:
        return geometry.intersection(area).area > MIN_OVERLAP_M2
    return area.intersects(geometry)


def analyse(
    layout: Layout,
    polygon: dict,
    year: int,
    *,
    own_id: str | None = None,
    later_ids: frozenset[str] = frozenset(),
) -> ClearingReport:
    """What a clearing of `polygon` (GeoJSON) at `year` would do to `layout`.

    `own_id` is the intervention doing the clearing: what it places itself is
    never cleared by it. `later_ids` are interventions made after it: what they
    place in that very year is left alone (an earlier year is not: it was
    there first)."""
    area = to_projected(polygon)
    candidates: list[tuple[int, Entry, str]] = []
    geometries: list[dict] = []
    for index, entry in enumerate(layout.entries):
        if not exists_at(entry, year):
            continue
        owner = _owner(layout, entry)
        if owner is not None and (owner == own_id or (owner in later_ids and entry.start >= year)):
            continue
        kind, geometry = _kind_and_geometry(layout, entry)
        candidates.append((index, entry, kind))
        geometries.append(geometry)

    report = ClearingReport()
    for (index, entry, kind), geometry in zip(candidates, project(geometries), strict=True):
        if kind == "cover":
            overlap = polygonal(geometry.intersection(area))
            if overlap is not None and overlap.area > MIN_OVERLAP_M2:
                cover_type = entry.cover.cover_type
                report.covers.append(CoveredArea(index, cover_type, overlap, cover_type in CLEARED_COVER_WARNING_TYPES))
        elif kind in PROTECTED_ELEMENT_TYPES:
            if _blocks(kind, entry.element.properties, geometry, area):
                report.blocking.append(BlockingElement(index, entry.element.id, kind))
        elif kind in CLEARABLE_ELEMENT_TYPES:
            if geometry.geom_type in LINES:
                if geometry.intersection(area).length < MIN_OVERLAP_LENGTH_M:
                    continue
                rest = geometry.difference(area)
                report.elements.append(ClearedElement(index, kind, rest if rest.length >= MIN_OVERLAP_LENGTH_M else None))
            elif area.intersects(geometry):
                report.elements.append(ClearedElement(index, kind))
    return report
