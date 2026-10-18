"""The rural domain pack: what the core needs from the rural domain (see
civic_engagement/domain.py). The model is a stub for now (model.py)."""

from civic_engagement.domain import DomainPack
from civic_engagement.models.schema import (
    BaselineScene,
    CoverPolygon,
    DiscreteElement,
    IndicatorValues,
    Intervention,
)
from rural_digital_twin import model
from rural_digital_twin.cards import CARDS, COVER_OF_CARD
from rural_digital_twin.indicators import DESCRIPTORS, indicator_values
from rural_digital_twin.sites import DEFAULT_SITE, SITES


class RuralPack(DomainPack):
    id = "rural"
    sites = SITES
    default_site = DEFAULT_SITE
    horizon_years = 30
    cards = CARDS
    # "building": the core's occluder type, for the village (none yet).
    element_types = frozenset({"building"})
    cover_types = frozenset({"forest", "meadow", "grassland", "scrub", "rock", "residential", *COVER_OF_CARD.values()})
    indicators = DESCRIPTORS

    def evaluate(self, baseline: BaselineScene, interventions: list[Intervention]) -> model.Evaluated:
        return model.evaluate(baseline, interventions)

    def assemble(self, evaluation: model.Evaluated, t: int) -> tuple[list[DiscreteElement], list[CoverPolygon]]:
        return model.assemble(evaluation, t)

    def indicator_values(self, evaluation: model.Evaluated, t: int) -> IndicatorValues:
        return indicator_values(evaluation, t)
