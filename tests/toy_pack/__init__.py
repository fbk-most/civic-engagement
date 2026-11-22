"""A toy domain pack, for the core's tests: a square of about 300 m with a
building, a lawn and a paving, one card (a bench), an indicator of each
kind, a deferred one included, and an uncontrollable (the weather, which
changes how many sit on the benches and on the building's steps). Not an example, nor an app: just enough to
run the core without a real pack (see civic_engagement/domain.py)."""

from civic_engagement.config import SiteConfig
from civic_engagement.domain import DomainPack
from civic_engagement.models.schema import (
    BaselineScene,
    CardSpec,
    CoverPolygon,
    DiscreteElement,
    IndicatorDescriptor,
    IndicatorDescriptors,
    IndicatorGroup,
    IndicatorPart,
    IndicatorValues,
    Intervention,
    Uncontrollables,
    UncontrollableSpec,
    UncontrollableValue,
)

DATA_DIR = "tests/toy_pack/data"

# The square's corners, west to east and south to north (about 300 m).
WEST, EAST, SOUTH, NORTH = 11.0, 11.004, 46.0, 46.0027

SITE = SiteConfig(
    site_id="toy_square",
    name="Toy square",
    site_boundary_geojson={
        "type": "Polygon",
        "coordinates": [[[WEST, SOUTH], [EAST, SOUTH], [EAST, NORTH], [WEST, NORTH], [WEST, SOUTH]]],
    },
    boundary_status="provisional",
    data_dir=DATA_DIR,
)

DESCRIPTORS = IndicatorDescriptors(
    groups=[IndicatorGroup(id="square", label="Piazza", label_en="Square")],
    indicators=[
        IndicatorDescriptor(id="benches", group="square", kind="number", label="Panchine", label_en="Benches", key=True),
        IndicatorDescriptor(
            id="space_use", group="square", kind="breakdown", label="Uso dello spazio", label_en="Space use",
            unit="%", parts=[IndicatorPart(id="lawn", label="Prato", label_en="Lawn"),
                             IndicatorPart(id="paving", label="Pavimentato", label_en="Paving")],
        ),
        IndicatorDescriptor(
            id="seating", group="square", kind="flags", label="Sedute", label_en="Seating",
            parts=[IndicatorPart(id="any", label="Almeno una", label_en="At least one")],
        ),
        IndicatorDescriptor(id="sitters", group="square", kind="number", label="Persone sedute", label_en="Sitters"),
        IndicatorDescriptor(
            id="benches_slow", group="square", kind="number", label="Panchine (lento)", label_en="Benches (slow)",
            deferred=True,
        ),
    ],
)


WEATHER = UncontrollableSpec(
    id="weather",
    label="Tempo",
    label_en="Weather",
    values=[UncontrollableValue(id="sunny", label="sole", label_en="sunny"),
            UncontrollableValue(id="rainy", label="pioggia", label_en="rainy")],
    default="sunny",
)
SITTERS_PER_BENCH = {"sunny": 4, "rainy": 1}  # the building's steps seat as many


class Evaluated:
    def __init__(self, baseline: BaselineScene, benches: list[DiscreteElement], weather: str):
        self.baseline = baseline
        self.benches = benches
        self.weather = weather


def _benches(interventions: list[Intervention]) -> list[DiscreteElement]:
    return [
        DiscreteElement(id=f"bench-{iv.id}", type="bench", geometry=iv.geometry, source="intervention", intervention_id=iv.id)
        for iv in interventions
        if not iv.deleted and iv.card_type == "add_bench"
    ]


class ToyPack(DomainPack):
    id = "toy"
    sites = {SITE.site_id: SITE}
    default_site = SITE.site_id
    horizon_years = 10
    cards = [
        CardSpec(card_type="add_bench", label="Panchina", label_en="Bench", category="arredo", placement_type="point", params=[])
    ]
    element_types = frozenset({"building", "bench"})
    cover_types = frozenset({"lawn", "paving"})
    indicators = DESCRIPTORS
    uncontrollables = [WEATHER]

    def evaluate(
        self, baseline: BaselineScene, interventions: list[Intervention], uncontrollables: Uncontrollables | None = None
    ) -> Evaluated:
        return Evaluated(baseline, _benches(interventions), (uncontrollables or {}).get("weather", WEATHER.default))

    def assemble(self, evaluation: Evaluated, t: int) -> tuple[list[DiscreteElement], list[CoverPolygon]]:
        return [*evaluation.baseline.elements, *evaluation.benches], list(evaluation.baseline.covers)

    def indicator_values(self, evaluation: Evaluated, t: int) -> IndicatorValues:
        benches = len(evaluation.benches)
        return {
            "benches": benches,
            "space_use": {"lawn": 50.0, "paving": 50.0},
            "seating": {"any": benches > 0},
            "sitters": (benches + 1) * SITTERS_PER_BENCH[evaluation.weather],
        }

    def deferred_values(self, interventions: list[Intervention], t: int) -> IndicatorValues:
        return {"benches_slow": len(_benches(interventions))}
