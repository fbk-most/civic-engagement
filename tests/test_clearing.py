"""The clearing analysis (see civic_twin/domains/urban/clearing.py), on the
Piazza Dante baseline. The targets are picked from the data rather than named,
so a rebuilt baseline does not break the tests."""

import pytest
from shapely.geometry import box

from civic_twin.domains.urban.clearing import analyse, project, to_wgs84
from civic_twin.domains.urban.layout import build_layout
from civic_twin.geo_utils import to_projected
from civic_twin.models.schema import Intervention
from civic_twin.scene import load_baseline


@pytest.fixture(scope="module")
def baseline():
    return load_baseline()


@pytest.fixture(scope="module")
def layout(baseline):
    return build_layout(baseline, [])


def around(point, half: float) -> dict:
    """A square of side 2 * half metres centred on a projected point, as GeoJSON."""
    return to_wgs84(box(point.x - half, point.y - half, point.x + half, point.y + half))


def intervention(card_type: str, geometry: dict, year: int, id: str = "int-test", params=None) -> Intervention:
    return Intervention(
        id=id, card_type=card_type, geometry=geometry, params=params or {},
        created_at="2026-01-01T00:00:00+00:00", planted_year=year,
    )


def cleared_ids(layout, report) -> set[str]:
    ids = set()
    for cleared in report.elements:
        entry = layout.entries[cleared.entry]
        ids.add(entry.element.id if entry.element is not None else layout.trees[entry.tree].element_id)
    return ids


def test_a_polygon_over_a_building_is_blocked(baseline, layout):
    building = next(e for e in baseline.elements if e.type == "building")
    point = to_projected(building.geometry).representative_point()
    report = analyse(layout, around(point, 1.0), year=0)
    assert (building.id, "building") in {(b.id, b.type) for b in report.blocking}


def test_a_polygon_over_a_street_is_blocked(baseline, layout):
    street = next(e for e in baseline.elements if e.type == "street")
    line = to_projected(street.geometry)
    point = line.interpolate(0.5, normalized=True)
    report = analyse(layout, around(point, 1.0), year=0)
    assert street.id in {b.id for b in report.blocking}


def test_a_polygon_in_the_pond_replaces_water_and_warns(baseline, layout):
    pond = next(c for c in baseline.covers if c.cover_type == "water")
    point = to_projected(pond.geometry).representative_point()
    report = analyse(layout, around(point, 5.0), year=0)
    water = [c for c in report.covers if c.cover_type == "water"]
    assert len(water) == 1 and water[0].needs_warning
    assert water[0].region.area == pytest.approx(100.0, rel=0.01)
    assert not report.blocking


def test_a_polygon_in_the_lawn_replaces_it_without_a_warning(baseline, layout):
    lawn = max((c for c in baseline.covers if c.cover_type == "lawn"), key=lambda c: to_projected(c.geometry).area)
    pond = to_projected(next(c for c in baseline.covers if c.cover_type == "water").geometry)
    # A spot of lawn well away from the pond.
    point = next(
        p for p in (to_projected(lawn.geometry).representative_point(),) if pond.distance(p) > 10
    )
    report = analyse(layout, around(point, 3.0), year=0)
    assert {c.cover_type for c in report.covers} == {"lawn"}
    assert not any(c.needs_warning for c in report.covers)


def test_a_tree_inside_the_polygon_is_cleared(baseline, layout):
    projected = project([t.geometry for t in baseline.elements if t.type == "tree"])
    trees = [t for t in baseline.elements if t.type == "tree"]
    for tree, point in zip(trees, projected, strict=True):
        report = analyse(layout, around(point, 1.0), year=0)
        if not report.blocking:
            assert tree.id in cleared_ids(layout, report)
            assert report.elements_by_type["tree"] >= 1
            return
    pytest.fail("every tree is next to something protected")


def test_a_path_is_cut_at_the_edge_of_the_polygon(baseline, layout):
    for path in (e for e in baseline.elements if e.type == "path"):
        line = to_projected(path.geometry)
        if line.length < 20:
            continue
        midpoint = line.interpolate(0.5, normalized=True)
        polygon = around(midpoint, 2.0)
        report = analyse(layout, polygon, year=0)
        cut = [c for c in report.elements if c.type == "path" and layout.entries[c.entry].element.id == path.id]
        if not cut or cut[0].remainder is None:
            continue
        inside = line.intersection(to_projected(polygon)).length
        assert inside > 0
        assert cut[0].remainder.length == pytest.approx(line.length - inside, abs=0.01)
        return
    pytest.fail("no long enough path to cut")


def test_only_what_exists_at_the_year_is_cleared(baseline):
    spot = to_projected(next(c for c in baseline.covers if c.cover_type == "lawn").geometry).representative_point()
    bench = intervention("add_bench", {"type": "Point", "coordinates": to_wgs84(spot)["coordinates"]}, year=10)
    layout = build_layout(baseline, [bench])
    polygon = around(spot, 1.0)

    def benches(year, **kwargs):
        return analyse(layout, polygon, year, **kwargs).elements_by_type.get("bench", 0)

    assert benches(5) == 0  # not placed yet
    assert benches(10) == 1
    assert benches(10, own_id=bench.id) == 0  # a card never clears its own
    assert benches(10, later_ids=frozenset({bench.id})) == 0  # made after: untouched that year
    assert benches(12, later_ids=frozenset({bench.id})) == 1  # made after, but in an earlier year: it was there first
