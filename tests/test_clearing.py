"""The clearing analysis (see civic_twin/domains/urban/clearing.py), on the
Piazza Dante baseline. The targets are picked from the data rather than named,
so a rebuilt baseline does not break the tests."""

import pytest
from shapely.geometry import box

from civic_twin.domains.urban.clearing import analyse, project, to_wgs84
from civic_twin.domains.urban.layout import build_layout, cultivation_area
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


def test_a_polygon_in_the_pond_is_blocked(baseline, layout):
    pond = next(c for c in baseline.covers if c.cover_type == "water")
    point = to_projected(pond.geometry).representative_point()
    report = analyse(layout, around(point, 5.0), year=0)
    assert (pond.id, "water") in {(b.id, b.type) for b in report.blocking}
    assert not [c for c in report.covers if c.cover_type == "water"]


def test_the_pond_blocks_up_to_the_margin_and_no_further(baseline, layout):
    """A ring drawn 0.5 m outside the pond is within the 2 m margin; one 2.5 m
    outside is not (only the margin matters here: the check passes the area)."""
    pond = next(c for c in baseline.covers if c.cover_type == "water")
    shape = to_projected(pond.geometry)

    def blocked(inner: float, outer: float) -> bool:
        ring = to_wgs84(shape.buffer(outer).difference(shape.buffer(inner)))
        area = cultivation_area(ring)
        return pond.id in {b.id for b in analyse(layout, area, year=0).blocking}

    assert blocked(0.5, 1.0)
    assert not blocked(2.5, 3.0)


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


def test_a_path_is_cleared_whole_and_warned_of(baseline, layout):
    for path in (e for e in baseline.elements if e.type == "path"):
        line = to_projected(path.geometry)
        if line.length < 20:
            continue
        polygon = around(line.interpolate(0.5, normalized=True), 2.0)
        area = to_projected(cultivation_area(polygon))
        report = analyse(layout, cultivation_area(polygon), year=0)
        found = [c for c in report.elements if c.type == "path" and layout.entries[c.entry].element.id == path.id]
        assert found and found[0].needs_warning
        assert found[0].beyond_m == pytest.approx(line.difference(area).length, abs=0.01)
        assert found[0].beyond_m > 0
        return
    pytest.fail("no long enough path to cross")


def test_a_path_wholly_inside_is_cleared_without_a_warning(baseline, layout):
    for path in (e for e in baseline.elements if e.type == "path"):
        line = to_projected(path.geometry)
        if line.length > 5:
            continue
        report = analyse(layout, cultivation_area(to_wgs84(line.buffer(4.0))), year=0)
        found = [c for c in report.elements if c.type == "path" and layout.entries[c.entry].element.id == path.id]
        if found and not found[0].beyond_m:
            assert not found[0].needs_warning
            return
    pytest.skip("no short path inside an area clear of everything else")


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


def _cut_tree_in_the_open(baseline, layout):
    """A baseline tree that is cut within the horizon, with nothing protected
    around it: (tree, its projected point)."""
    trees = [t for t in baseline.elements if t.type == "tree" and t.properties.get("cut_year") is not None]
    for tree, point in zip(trees, project([t.geometry for t in trees]), strict=True):
        if not analyse(layout, around(point, 1.0), year=tree.properties["cut_year"]).blocking:
            return tree, point
    pytest.skip("no cut tree away from anything protected")


def test_a_tree_that_was_cut_is_cleared_as_a_stump(baseline, layout):
    tree, point = _cut_tree_in_the_open(baseline, layout)
    cut = tree.properties["cut_year"]
    before = analyse(layout, around(point, 1.0), year=cut - 1) if cut > 0 else None
    after = analyse(layout, around(point, 1.0), year=cut)
    if before is not None:
        assert tree.id in cleared_ids(layout, before)
        assert before.elements_by_type.get("tree", 0) >= 1
    assert tree.id in cleared_ids(layout, after)
    assert after.elements_by_type.get("stump", 0) >= 1


def test_a_stump_a_replanting_has_replaced_is_not_cleared_again(baseline):
    layout = build_layout(baseline, [])
    tree, point = _cut_tree_in_the_open(baseline, layout)
    cut = tree.properties["cut_year"]
    replant = intervention(
        "plant_tree", tree.geometry, year=cut + 1, id="int-replant", params={"species": "linden"}
    ).model_copy(update={"replaces_element_id": tree.id})
    layout = build_layout(baseline, [replant])
    polygon = around(point, 1.0)
    assert tree.id in cleared_ids(layout, analyse(layout, polygon, year=cut))
    assert tree.id not in cleared_ids(layout, analyse(layout, polygon, year=cut + 1))
