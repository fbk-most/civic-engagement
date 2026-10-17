"""The urban domain pack: what the core needs from the urban domain (see
civic_engagement/domain.py).

A scenario is evaluated once by the urban model for the whole horizon (see
model.py), from its layout (layout.py: which elements and covers exist,
where, from which year); a year's scene is the layout's entries at that
year, with the trees as the model grew them.
"""

from dataclasses import dataclass
from functools import lru_cache

from fastapi import APIRouter

from bologna_civic_dt import felt_field
from bologna_civic_dt.cards import CARDS
from bologna_civic_dt.encode import encode
from bologna_civic_dt.indicators import DESCRIPTORS, indicator_values
from bologna_civic_dt.layout import Layout, TreeSlot, build_layout
from bologna_civic_dt.model import UrbanEvaluator, UrbanOutput, build_model
from bologna_civic_dt.parameters import HORIZON_YEARS
from bologna_civic_dt.sites import DEFAULT_SITE, SITE, SITES
from bologna_civic_dt.trees import species_traits
from bologna_civic_dt.types import COVER_TYPE_SET, ELEMENT_TYPES
from civic_engagement.domain import DomainPack
from civic_engagement.models.schema import (
    BaselineScene,
    CoverPolygon,
    DiscreteElement,
    IndicatorValues,
    Intervention,
)

ROAD_MARKING_TYPES = {"crossing", "lane_divider"}

ALIVE, STUMP = 1, 2


@lru_cache(maxsize=1)
def _evaluator() -> UrbanEvaluator:
    return UrbanEvaluator(build_model())


@dataclass(frozen=True)
class Evaluated:
    layout: Layout
    output: UrbanOutput


def _tree_element(slot: TreeSlot, output: UrbanOutput, k: int, t: int) -> DiscreteElement | None:
    status = int(output.tree_status[k, t])
    if status not in (ALIVE, STUMP):
        return None
    diameter = float(output.tree_diameter[k, t])
    height = float(output.tree_height[k, t])
    traits = species_traits(slot.species)
    if slot.origin == "baseline":
        properties = {
            "species": slot.species, "age_class": slot.age_class,
            "canopy_diameter": diameter if status == ALIVE else 0.0,
            "height": round(height, 2),
            "cut_year": slot.cut_year, "status": "alive" if status == ALIVE else "stump",
            **traits,
        }
    else:
        properties = {
            "species": slot.species,
            "canopy_diameter": diameter,
            "height": round(height, 2),
            **traits,
        }
    return DiscreteElement(
        id=slot.element_id,
        type="tree",
        source=slot.source,
        intervention_id=slot.intervention_id,
        geometry=slot.geometry,
        properties=properties,
    )


def assemble_all(evaluated: Evaluated, t: int) -> tuple[list[DiscreteElement], list[CoverPolygon]]:
    """Every element and cover at year t, road markings included whatever
    the site's `show_road_markings` (the felt-temperature field sees them)."""
    elements: list[DiscreteElement] = []
    covers: list[CoverPolygon] = []
    for entry in evaluated.layout.entries:
        if t < entry.start:
            continue
        if entry.cover is not None:
            covers.append(entry.cover)
        elif entry.element is not None:
            elements.append(entry.element)
        else:
            tree = _tree_element(evaluated.layout.trees[entry.tree], evaluated.output, entry.tree, t)
            if tree is not None:
                elements.append(tree)
    return elements, covers


class UrbanPack(DomainPack):
    id = "urban"
    sites = SITES
    default_site = DEFAULT_SITE
    horizon_years = HORIZON_YEARS
    cards = CARDS
    element_types = ELEMENT_TYPES
    cover_types = COVER_TYPE_SET
    indicators = DESCRIPTORS

    def evaluate(self, baseline: BaselineScene, interventions: list[Intervention]) -> Evaluated:
        layout = build_layout(baseline, interventions)
        return Evaluated(layout=layout, output=_evaluator().run(encode(layout)))

    def assemble(self, evaluation: Evaluated, t: int) -> tuple[list[DiscreteElement], list[CoverPolygon]]:
        elements, covers = assemble_all(evaluation, t)
        if not SITE.show_road_markings:
            elements = [e for e in elements if e.type not in ROAD_MARKING_TYPES]
        return elements, covers

    def indicator_values(self, evaluation: Evaluated, t: int) -> IndicatorValues:
        return indicator_values(evaluation.output, t)

    def deferred_values(self, interventions: list[Intervention], t: int) -> IndicatorValues:
        return felt_field.thermal(interventions, t)

    def deferred_series(self, interventions: list[Intervention], years: list[int]) -> list[IndicatorValues]:
        return felt_field.thermal_series(interventions, years)

    def routers(self) -> list[APIRouter]:
        from bologna_civic_dt.routes import router

        return [router]
