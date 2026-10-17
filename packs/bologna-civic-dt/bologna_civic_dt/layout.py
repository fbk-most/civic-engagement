"""What exists in a scenario, where, and from (until) which year — the
model-free half of what `model/resolve.py` used to do.

Every intervention appears from its `planted_year` on: a card placed while
previewing +12y represents "if we do this in 12 years", not something that
has always existed. Baseline trees carry a fixed, offline-assigned
`age_class` and `cut_year` (see `ingestion/build_baseline.py`); from
`cut_year` on a baseline tree is a stump, unless an intervention replants it
(`Intervention.replaces_element_id`), in which case the stump disappears
once the replant is in place too.

How big each tree is at a given year (and so whether it is alive or a
stump) is the model's business — see `model.py`. The layout only records
what the model needs to know about each tree (`TreeSlot`), and `pack.py`
puts the two together for a given year.
"""

from dataclasses import dataclass, field
from typing import Literal

from bologna_civic_dt.parameters import GROVE_PLANTING_DIAMETER
from bologna_civic_dt.sites import SITE
from shapely.ops import unary_union

from civic_engagement.geo_utils import centroid_point, grove_points_within, points_along, to_projected_many
from civic_engagement.models.schema import BaselineScene, CoverPolygon, DiscreteElement, Intervention

# A grove's or a row's trees are counted per card for its cost (see encode.py).
TreeOrigin = Literal["baseline", "planted", "grove", "row"]


@dataclass(frozen=True)
class TreeSlot:
    element_id: str
    source: str
    intervention_id: str | None
    geometry: dict
    origin: TreeOrigin
    species: str
    # Canopy diameter at `start` (planting size), or at t=0 for a baseline tree.
    initial_diameter: float
    start: int
    age_class: str | None = None
    cut_year: int | None = None
    replant_year: int | None = None


@dataclass(frozen=True)
class Entry:
    """One element or cover of the scene, in the order it is served."""

    start: int
    element: DiscreteElement | None = None
    cover: CoverPolygon | None = None
    tree: int | None = None  # index into Layout.trees


@dataclass
class Layout:
    site_boundary: dict
    entries: list[Entry] = field(default_factory=list)
    trees: list[TreeSlot] = field(default_factory=list)
    interventions: list[Intervention] = field(default_factory=list)

    def add_tree(self, slot: TreeSlot) -> None:
        self.entries.append(Entry(start=slot.start, tree=len(self.trees)))
        self.trees.append(slot)


def _element(
    intervention: Intervention, element_type: str, properties: dict, geometry=None, suffix=""
) -> DiscreteElement:
    return DiscreteElement(
        id=f"element-{intervention.id}{suffix}",
        type=element_type,
        source="intervention",
        intervention_id=intervention.id,
        geometry=geometry if geometry is not None else intervention.geometry,
        properties=properties,
    )


def _cover(intervention: Intervention, cover_type: str) -> CoverPolygon:
    return CoverPolygon(
        id=f"cover-{intervention.id}",
        geometry=intervention.geometry,
        cover_type=cover_type,
        source="intervention",
        intervention_id=intervention.id,
    )


def _planted_tree(
    intervention: Intervention, origin: TreeOrigin, geometry: dict, diameter: float, suffix=""
) -> TreeSlot:
    return TreeSlot(
        element_id=f"element-{intervention.id}{suffix}",
        source="intervention",
        intervention_id=intervention.id,
        geometry=geometry,
        origin=origin,
        species=intervention.params.get("species", "unknown"),
        initial_diameter=diameter,
        start=intervention.planted_year,
    )


# Where a tree row doesn't plant (see `_room_for_trees`): this far from a
# path's edge or a building, and nowhere under another tree's crown.
ROW_CLEARANCE_M = 0.5
ROW_TRAFFIC_TYPES = ("path", "street", "crossing")


def _room_for_trees(layout: Layout, points: list[dict]) -> list[dict]:
    """The points where a tree fits: not on a path, street or crossing, not
    in or against a building, not under a tree already there (at its
    planting size) — so a row drawn along a path, across it or past old
    trees only plants where it makes sense."""
    elements = [e.element for e in layout.entries if e.element is not None]
    traffic = [e for e in elements if e.type in ROW_TRAFFIC_TYPES]
    buildings = [e for e in elements if e.type == "building"]
    projected = to_projected_many(
        [e.geometry for e in traffic] + [e.geometry for e in buildings] + [s.geometry for s in layout.trees] + points
    )
    n_traffic, n_buildings, n_trees = len(traffic), len(buildings), len(layout.trees)
    blocked = unary_union(
        [g.buffer(e.properties.get("width", 2.0) / 2 + ROW_CLEARANCE_M) for e, g in zip(traffic, projected)]
        + [g.buffer(ROW_CLEARANCE_M) for g in projected[n_traffic:n_traffic + n_buildings]]
        + [
            g.buffer(max(slot.initial_diameter / 2, 1.0))
            for slot, g in zip(layout.trees, projected[n_traffic + n_buildings:n_traffic + n_buildings + n_trees])
        ]
    )
    candidates = projected[n_traffic + n_buildings + n_trees:]
    return [point for point, at in zip(points, candidates) if not blocked.contains(at)]


def _add_intervention(layout: Layout, intervention: Intervention) -> None:
    start = intervention.planted_year
    params = intervention.params
    card = intervention.card_type

    def element(*args, **kwargs) -> None:
        layout.entries.append(Entry(start=start, element=_element(intervention, *args, **kwargs)))

    def cover(cover_type: str) -> None:
        layout.entries.append(Entry(start=start, cover=_cover(intervention, cover_type)))

    if card == "plant_tree":
        diameter = params.get("canopy_diameter", 1.5)
        layout.add_tree(_planted_tree(intervention, "planted", intervention.geometry, diameter))
    elif card == "new_path":
        element("path", {"width": params.get("width", 2.0), "material": params.get("material", "gravel")})
    elif card in ("add_streetlight", "add_bench", "add_kiosk"):
        element(card.removeprefix("add_"), {})
    elif card == "plant_tree_row":
        # One tree every `spacing` metres or so along the line, ends
        # included, wherever there's room.
        diameter = params.get("canopy_diameter", 2.0)
        points = _room_for_trees(layout, points_along(intervention.geometry, params.get("spacing", 8.0)))
        for i, point in enumerate(points):
            layout.add_tree(_planted_tree(intervention, "row", point, diameter, suffix=f"-{i}"))
    elif card == "add_streetlight_path":
        # One streetlight every `spacing` metres or so, ends included.
        for i, point in enumerate(points_along(intervention.geometry, params.get("spacing", 15.0))):
            element("streetlight", {}, point, suffix=f"-{i}")
    elif card == "add_pergola":
        element("pergola", {"size": params.get("size", "medium")})
    elif card == "change_ground_cover":
        cover(params.get("cover_type", "meadow"))
    elif card == "plant_grove":
        # The area always converts to lawn, with small trees scattered in it.
        cover("lawn")
        points = grove_points_within(
            intervention.geometry, params.get("spacing", 5.0), seed=intervention.id,
            algorithm=SITE.grove_placement_algorithm,
        )
        for i, point in enumerate(points):
            layout.add_tree(_planted_tree(intervention, "grove", point, GROVE_PLANTING_DIAMETER, suffix=f"-{i}"))
    elif card == "add_playground":
        cover("playground_surface")
        equipment_at = centroid_point(intervention.geometry)
        element("playground", {"age_range": params.get("age_range", "junior")}, equipment_at)
    elif card == "add_fitness_area":
        cover("sport_surface")
        equipment_at = centroid_point(intervention.geometry)
        element("fitness_area", {"target_age": params.get("target_age", "teens")}, equipment_at)


def build_layout(baseline: BaselineScene, interventions: list[Intervention]) -> Layout:
    layout = Layout(site_boundary=baseline.site_boundary, interventions=list(interventions))
    replant_year = {iv.replaces_element_id: iv.planted_year for iv in interventions if iv.replaces_element_id}

    for element in baseline.elements:
        if element.type != "tree":
            layout.entries.append(Entry(start=0, element=element))
            continue
        props = element.properties
        layout.add_tree(TreeSlot(
            element_id=element.id,
            source="baseline",
            intervention_id=None,
            geometry=element.geometry,
            origin="baseline",
            species=props.get("species", "unknown"),
            initial_diameter=props.get("canopy_diameter", 4.0),
            start=0,
            age_class=props.get("age_class", "mature"),
            cut_year=props.get("cut_year"),
            replant_year=replant_year.get(element.id),
        ))

    for cover in baseline.covers:
        layout.entries.append(Entry(start=0, cover=cover))

    for intervention in interventions:
        _add_intervention(layout, intervention)

    return layout
