# The rural pack, called directly: the tests run with the urban pack
# registered (see conftest.py), and one process has one pack.
import json

import pytest

from civic_engagement.models.schema import BaselineScene, Intervention
from rural_digital_twin.cards import CARDS
from rural_digital_twin.pack import RuralPack
from rural_digital_twin.sites import SITES


def _square(lng: float, lat: float) -> dict:
    """About 1 ha, its south-west corner at lng, lat."""
    return {
        "type": "Polygon",
        "coordinates": [[[lng, lat], [lng + 0.0013, lat], [lng + 0.0013, lat + 0.0009], [lng, lat + 0.0009], [lng, lat]]],
    }


# Mid-slope, inside the spruce stand.
IN_FOREST = _square(10.775, 46.1185)


def _intervention(id: str, card_type: str, geometry: dict, planted_year: int = 0) -> Intervention:
    card = next(c for c in CARDS if c.card_type == card_type)
    return Intervention(
        id=id, card_type=card_type, geometry=geometry, params={p.key: p.default for p in card.params},
        created_at=f"2026-10-18T00:00:0{id[-1]}Z", planted_year=planted_year,
    )


@pytest.fixture(scope="module")
def baseline() -> BaselineScene:
    with open(SITES["bocenago"].baseline_json_path) as f:
        return BaselineScene(**json.load(f))


def test_baseline_has_stands_and_land_covers(baseline: BaselineScene) -> None:
    pack = RuralPack()
    assert baseline.site_boundary == SITES["bocenago"].site_boundary_geojson
    assert {c.cover_type for c in baseline.covers} <= pack.cover_types
    stands = [c for c in baseline.covers if c.cover_type == "forest"]
    assert stands and all({"species", "species_mix", "density_per_ha"} <= c.properties.keys() for c in stands)
    assert 500 < pack.indicator_values(pack.evaluate(baseline, []), 0)["forest_ha"] < 845


def test_felling_and_replanting(baseline: BaselineScene) -> None:
    pack = RuralPack()
    as_is = pack.indicator_values(pack.evaluate(baseline, []), 0)["forest_ha"]
    evaluated = pack.evaluate(baseline, [
        _intervention("a1", "fell_forest", IN_FOREST, 0),
        _intervention("a2", "plant_forest", IN_FOREST, 10),
    ])
    felled = pack.indicator_values(evaluated, 0)
    assert 0.9 < felled["felled_ha"] < 1.2
    assert felled["forest_ha"] == round(as_is - felled["felled_ha"])
    assert pack.indicator_values(evaluated, 10)["forest_ha"] == as_is

    _, covers = pack.assemble(evaluated, 15)
    planting = next(c for c in covers if c.cover_type == "planting")
    assert planting.properties["age_years"] == 5 and planting.properties["species"] == "mixed"
    assert {c.cover_type for c in covers} <= pack.cover_types
