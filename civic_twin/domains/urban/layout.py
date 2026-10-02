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
what the model needs to know about each tree (`TreeSlot`), and `scene.py`
puts the two together for a given year.
"""

from dataclasses import dataclass, field
from typing import Literal

from civic_twin.domains.urban.parameters import GROVE_PLANTING_DIAMETER
from civic_twin.geo_utils import centroid_point, grove_points_within
from civic_twin.models.schema import BaselineScene, CoverPolygon, DiscreteElement, Intervention

# A grove's trees are counted per grove for its cost (see encode.py).
TreeOrigin = Literal["baseline", "planted", "grove"]


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
    elif card == "add_pergola":
        element("pergola", {"size": params.get("size", "medium")})
    elif card == "change_ground_cover":
        cover(params.get("cover_type", "meadow"))
    elif card == "plant_grove":
        # The area always converts to lawn, with small trees scattered in it.
        cover("lawn")
        points = grove_points_within(intervention.geometry, params.get("spacing", 5.0), seed=intervention.id)
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
