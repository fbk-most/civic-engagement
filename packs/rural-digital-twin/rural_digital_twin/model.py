"""A stub of the rural model, standing in until the real one (forest stands,
growth, disturbances...) exists: each card's area becomes a cover from the
year it was placed, and the indicators are the areas planted and felled.
"""

from dataclasses import dataclass

from civic_engagement.geo_utils import area_m2
from civic_engagement.models.schema import BaselineScene, CoverPolygon, DiscreteElement, Intervention
from rural_digital_twin.cards import COVER_OF_CARD


@dataclass(frozen=True)
class Evaluated:
    baseline: BaselineScene
    # Each live intervention, with its area in hectares.
    interventions: list[tuple[Intervention, float]]


def evaluate(baseline: BaselineScene, interventions: list[Intervention]) -> Evaluated:
    live = [iv for iv in interventions if not iv.deleted and iv.card_type in COVER_OF_CARD]
    return Evaluated(baseline=baseline, interventions=[(iv, area_m2(iv.geometry) / 10_000) for iv in live])


def active(evaluated: Evaluated, t: int) -> list[tuple[Intervention, float]]:
    return [(iv, ha) for iv, ha in evaluated.interventions if t >= iv.planted_year]


def assemble(evaluated: Evaluated, t: int) -> tuple[list[DiscreteElement], list[CoverPolygon]]:
    covers = list(evaluated.baseline.covers) + [
        CoverPolygon(
            id=f"cover-{iv.id}",
            geometry=iv.geometry,
            cover_type=COVER_OF_CARD[iv.card_type],
            source="intervention",
            intervention_id=iv.id,
        )
        for iv, _ in active(evaluated, t)
    ]
    return list(evaluated.baseline.elements), covers
