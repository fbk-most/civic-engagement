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
- clearable objects touching the area are cleared whole, even where they reach
  beyond it (a path crossing its edge goes entirely, which is warned of);
- protected objects (buildings, streets...) and covers (water) under the area
  block it;
- every other cover under the area is replaced; some need a warning first.

Everything is measured in the projected CRS, in metres.
"""

from collections import Counter
from dataclasses import dataclass, field, replace

import geopandas as gpd
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from civic_twin.config import PROJECTED_CRS, WGS84_CRS
from civic_twin.domains.urban.layout import Entry, Layout, TreeSlot, cultivation_area
from civic_twin.domains.urban.parameters import (
    CLEARABLE_ELEMENT_TYPES,
    CLEARED_COVER_WARNING_TYPES,
    PROTECTED_COVER_TYPES,
    PROTECTED_ELEMENT_TYPES,
    WARNED_ELEMENT_TYPES,
)
from civic_twin.geo_utils import to_projected
from civic_twin.models.schema import CoverPolygon

# The cards that clear their area before they act on it.
CLEARING_CARDS = {"cultivate_terrain"}

# An overlap smaller than this is two shapes touching, not one on the other.
MIN_OVERLAP_M2 = 0.5
# A length of path, or of a line-shaped protected object, that counts as inside.
MIN_OVERLAP_LENGTH_M = 0.5
# Width of a street whose width is not known, and of a marking's.
DEFAULT_STREET_WIDTH_M = 6.0
DEFAULT_MARKING_WIDTH_M = 0.5
# How far a cover's remainder goes on under the cover that replaced part of it.
# They meet along one line that, drawn from two separately rounded copies of
# it, leaves hairline cracks the background shows through; the new cover is
# above, so this overlap is never seen.
SEAM_M = 0.05
# How far around a cleared area to look for the cover that surrounds it, and
# what to fill it with when there is none.
SURROUND_RING_M = 3.0
DEFAULT_FILL_COVER = "paving"

LINES = ("LineString", "MultiLineString")
AREAS = ("Polygon", "MultiPolygon")


@dataclass(frozen=True)
class ClearedElement:
    entry: int  # index into Layout.entries
    type: str  # the element's type; "tree" for a tree, "stump" for what a cut tree left
    # How much of it lies outside the area (a line's length, in metres) and
    # whether it is removed whole all the same, which needs a warning.
    beyond_m: float = 0.0
    needs_warning: bool = False


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
    def whole_removals(self) -> dict[str, tuple[int, float]]:
        """Per type, how many objects need the warning and the length of them
        outside the area."""
        removals: dict[str, tuple[int, float]] = {}
        for cleared in self.elements:
            if cleared.needs_warning:
                count, beyond = removals.get(cleared.type, (0, 0.0))
                removals[cleared.type] = (count + 1, beyond + cleared.beyond_m)
        return removals

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


def owner(layout: Layout, entry: Entry) -> str | None:
    if entry.element is not None:
        return entry.element.intervention_id
    if entry.cover is not None:
        return entry.cover.intervention_id
    return layout.trees[entry.tree].intervention_id


def kind_and_geometry(layout: Layout, entry: Entry) -> tuple[str, dict]:
    if entry.element is not None:
        return entry.element.type, entry.element.geometry
    if entry.cover is not None:
        return "cover", entry.cover.geometry
    return "tree", layout.trees[entry.tree].geometry


def _tree_kind(slot: TreeSlot, year: int) -> str | None:
    """What a tree's slot is at `year`: a "tree", or the "stump" it left once
    it was cut (the clearing then removes a stump, not a tree), or None once a
    replanting has taken the stump's place (the new tree is a slot of its own)."""
    if slot.cut_year is None or year < slot.cut_year:
        return "tree"
    if slot.replant_year is not None and year >= slot.replant_year:
        return None
    return "stump"


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
        made_by = owner(layout, entry)
        if made_by is not None and (made_by == own_id or (made_by in later_ids and entry.start >= year)):
            continue
        kind, geometry = kind_and_geometry(layout, entry)
        if entry.tree is not None:
            kind = _tree_kind(layout.trees[entry.tree], year)
            if kind is None:
                continue
        candidates.append((index, entry, kind))
        geometries.append(geometry)

    report = ClearingReport()
    for (index, entry, kind), geometry in zip(candidates, project(geometries), strict=True):
        if kind == "cover":
            overlap = polygonal(geometry.intersection(area))
            if overlap is not None and overlap.area > MIN_OVERLAP_M2:
                cover_type = entry.cover.cover_type
                if cover_type in PROTECTED_COVER_TYPES:
                    report.blocking.append(BlockingElement(index, entry.cover.id, cover_type))
                else:
                    report.covers.append(
                        CoveredArea(index, cover_type, overlap, cover_type in CLEARED_COVER_WARNING_TYPES)
                    )
        elif kind in PROTECTED_ELEMENT_TYPES:
            if _blocks(kind, entry.element.properties, geometry, area):
                report.blocking.append(BlockingElement(index, entry.element.id, kind))
        elif kind in CLEARABLE_ELEMENT_TYPES:
            if geometry.geom_type in LINES:
                if geometry.intersection(area).length < MIN_OVERLAP_LENGTH_M:
                    continue
                beyond = geometry.difference(area).length
                warned = kind in WARNED_ELEMENT_TYPES and beyond >= MIN_OVERLAP_LENGTH_M
                report.elements.append(ClearedElement(index, kind, beyond, warned))
            elif area.intersects(geometry):
                report.elements.append(ClearedElement(index, kind))
    return report


def surrounding_cover_type(layout: Layout, region: BaseGeometry, year: int, own_id: str) -> str:
    """The cover around a cleared region: the one with most area in a ring
    around it (leaving out the covers that are not simply built over, such as
    water, which a cleared area never has under it, and any cover that is
    replaced with a warning)."""
    ring = region.buffer(SURROUND_RING_M).difference(region)
    covers = [
        e
        for e in layout.entries
        if e.cover is not None
        and exists_at(e, year)
        and e.cover.intervention_id != own_id
        and e.cover.cover_type not in CLEARED_COVER_WARNING_TYPES | PROTECTED_COVER_TYPES
    ]
    areas: Counter = Counter()
    for entry, geometry in zip(covers, project([e.cover.geometry for e in covers]), strict=True):
        areas[entry.cover.cover_type] += geometry.intersection(ring).area
    best = areas.most_common(1)
    return best[0][0] if best and best[0][1] > 0 else DEFAULT_FILL_COVER


def apply_clearing(layout: Layout) -> None:
    """Applies every clearing card of the layout, in order of year, to what
    was there before it (earlier clearings included).

    What is cleared ends in the year of the card, and is marked as cleared by
    it. A cover only partly under the area continues as a new entry for what
    lies outside; a cover that needs a warning also leaves its cleared area
    filled with the cover around it. The new entries take the place of the old in the order covers
    are drawn in, so what was above a cover stays above what replaces it."""
    clearings = sorted(
        ((index, iv) for index, iv in enumerate(layout.interventions) if iv.card_type in CLEARING_CARDS),
        key=lambda pair: (pair[1].planted_year, pair[0]),
    )
    for index, intervention in clearings:
        later = frozenset(iv.id for iv in layout.interventions[index + 1 :])
        area = cultivation_area(intervention.geometry)
        report = analyse(layout, area, intervention.planted_year, own_id=intervention.id, later_ids=later)
        _clear(layout, intervention, report)


def _clear(layout: Layout, intervention, report: ClearingReport) -> None:
    year, by = intervention.planted_year, intervention.id
    area = to_projected(cultivation_area(intervention.geometry))
    ended: dict[int, Entry] = {}
    after: dict[int, list[Entry]] = {}

    for cleared in report.elements:
        entry = layout.entries[cleared.entry]
        ended[cleared.entry] = replace(entry, end=year, cleared_by=by)
        if entry.tree is not None:
            layout.trees[entry.tree] = replace(layout.trees[entry.tree], clear_year=year)

    fills = 0
    for covered in report.covers:
        cover = layout.entries[covered.entry].cover
        ended[covered.entry] = replace(layout.entries[covered.entry], end=year, cleared_by=by)
        pieces: list[Entry] = []
        rest = polygonal(project([cover.geometry])[0].difference(area.buffer(-SEAM_M)))
        if rest is not None and rest.area > MIN_OVERLAP_M2:
            piece = cover.model_copy(
                update={"id": f"{cover.id}~{by}", "source": "intervention", "intervention_id": by,
                        "geometry": to_wgs84(rest)}
            )
            pieces.append(Entry(start=year, cover=piece))
        if covered.needs_warning:
            fills += 1
            fill = CoverPolygon(
                id=f"cover-{by}-fill-{fills}",
                geometry=to_wgs84(covered.region),
                cover_type=surrounding_cover_type(layout, covered.region, year, by),
                source="intervention",
                intervention_id=by,
            )
            pieces.append(Entry(start=year, cover=fill))
        after[covered.entry] = pieces

    entries: list[Entry] = []
    for index, entry in enumerate(layout.entries):
        entries.append(ended.get(index, entry))
        entries.extend(after.get(index, ()))
    layout.entries = entries
