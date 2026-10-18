# The rural pack, called directly: the tests run with the urban pack
# registered (see conftest.py), and one process has one pack.
import json

from civic_engagement.models.schema import BaselineScene, Intervention
from rural_digital_twin.cards import CARDS
from rural_digital_twin.pack import RuralPack
from rural_digital_twin.sites import SITES

# About 1 ha, near the village.
SQUARE = {
    "type": "Polygon",
    "coordinates": [[[10.76, 46.12], [10.7613, 46.12], [10.7613, 46.1209], [10.76, 46.1209], [10.76, 46.12]]],
}


def _intervention(id: str, card_type: str, planted_year: int = 0) -> Intervention:
    card = next(c for c in CARDS if c.card_type == card_type)
    return Intervention(
        id=id, card_type=card_type, geometry=SQUARE, params={p.key: p.default for p in card.params},
        created_at="2026-10-18T00:00:00Z", planted_year=planted_year,
    )


def test_baseline_matches_the_site() -> None:
    site = SITES["bocenago"]
    with open(site.baseline_json_path) as f:
        baseline = BaselineScene(**json.load(f))
    assert baseline.site_boundary == site.site_boundary_geojson
    assert len(site.site_boundary_geojson["coordinates"][0]) > 100


def test_cards_become_covers_from_their_year() -> None:
    pack = RuralPack()
    baseline = BaselineScene(site_boundary=SITES["bocenago"].site_boundary_geojson, elements=[], covers=[])
    evaluated = pack.evaluate(baseline, [_intervention("a", "plant_forest"), _intervention("b", "fell_forest", 5)])

    _, covers = pack.assemble(evaluated, 0)
    assert [c.cover_type for c in covers] == ["planting"]
    _, covers = pack.assemble(evaluated, 5)
    assert sorted(c.cover_type for c in covers) == ["felling", "planting"]
    assert {c.cover_type for c in covers} <= pack.cover_types

    values = pack.indicator_values(evaluated, 0)
    assert 0.9 < values["planted_ha"] < 1.2 and values["felled_ha"] == 0
    assert pack.indicator_values(evaluated, 5)["felled_ha"] == values["planted_ha"]
    assert {d.id for d in pack.indicators.indicators} == set(values)
