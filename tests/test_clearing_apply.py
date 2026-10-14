"""A clearing applied: what a "coltiva il terreno" card takes away, seen
through the layout, the scene the API serves and the model's indicators, on
the Piazza Dante baseline. Targets are picked from the data, not named."""

import pytest
from shapely.geometry import Point, box

from civic_twin import scene
from civic_twin.domains.urban.clearing import analyse, apply_clearing, project, to_wgs84
from civic_twin.domains.urban.layout import build_layout
from civic_twin.geo_utils import to_projected
from civic_twin.models.schema import Intervention

CLEAR_YEAR = 5


@pytest.fixture(scope="module")
def baseline():
    return scene.load_baseline()


@pytest.fixture
def session(monkeypatch):
    """Serves the scene for a given list of interventions, as the API would."""

    def serve(interventions: list[Intervention]) -> None:
        monkeypatch.setattr(scene.store, "list_interventions", lambda session_id="default": list(interventions))
        scene._scenario_cache.clear()

    yield serve
    scene._scenario_cache.clear()


def card(card_type: str, geometry: dict, year: int, id: str, params=None) -> Intervention:
    return Intervention(
        id=id, card_type=card_type, geometry=geometry, params=params or {},
        created_at="2026-01-01T00:00:00+00:00", planted_year=year,
    )


def square(centre, half: float) -> dict:
    return to_wgs84(box(centre.x - half, centre.y - half, centre.x + half, centre.y + half))


def cultivate(geometry: dict, year: int = CLEAR_YEAR, id: str = "int-cultivate") -> Intervention:
    return card("cultivate_terrain", geometry, year, id, {"purpose": "botanical"})


def across_pond(baseline) -> dict:
    """60 x 40 m over the pond, the lawn around it and a few paths."""
    pond = to_projected(next(c for c in baseline.covers if c.cover_type == "water").geometry)
    return to_wgs84(box(pond.centroid.x - 30, pond.centroid.y - 20, pond.centroid.x + 30, pond.centroid.y + 20))


def free_spots(baseline, half: float):
    """Spots on the big lawn, away from the pond, where a square of side
    2 * half blocks nothing protected."""
    layout = build_layout(baseline, [])
    lawns = [c for c in baseline.covers if c.cover_type == "lawn"]
    lawn = to_projected(max(lawns, key=lambda c: to_projected(c.geometry).area).geometry)
    pond = to_projected(next(c for c in baseline.covers if c.cover_type == "water").geometry)
    minx, miny, maxx, maxy = lawn.bounds
    x = minx
    while x < maxx:
        y = miny
        while y < maxy:
            p = Point(x, y)
            if lawn.contains(box(x - half, y - half, x + half, y + half)) and pond.distance(p) > half + 5:
                if not analyse(layout, square(p, half), 0).blocking:
                    yield p
            y += 10
        x += 10


def element_id(layout, entry_index: int) -> str:
    entry = layout.entries[entry_index]
    return entry.element.id if entry.element else layout.trees[entry.tree].element_id


def ids(s) -> tuple[set[str], set[str]]:
    """What the simulation shows: everything but what a clearing has taken
    away (which is still served, flagged)."""
    return {e.id for e in s.elements if not e.cleared_by}, {c.id for c in s.covers if not c.cleared_by}


def test_nothing_changes_before_the_year_of_the_card(baseline, session):
    session([])
    before = scene.current_scene(CLEAR_YEAR - 1)
    session([cultivate(across_pond(baseline))])
    s = scene.current_scene(CLEAR_YEAR - 1)
    assert ids(s) == ids(before)
    assert s.indicators == before.indicators


def test_cleared_objects_are_gone_from_the_year_of_the_card(baseline, session):
    polygon = across_pond(baseline)
    layout = build_layout(baseline, [])
    report = analyse(layout, polygon, CLEAR_YEAR)
    assert report.elements_by_type.keys() >= {"tree", "bench", "path"}
    cleared = {element_id(layout, c.entry) for c in report.elements if c.type != "path"}
    session([cultivate(polygon)])
    assert cleared <= ids(scene.current_scene(CLEAR_YEAR - 1))[0]
    assert not cleared & ids(scene.current_scene(CLEAR_YEAR))[0]
    assert not cleared & ids(scene.current_scene(CLEAR_YEAR + 10))[0]


def test_the_pond_is_replaced_by_the_cover_around_it(baseline, session):
    polygon = across_pond(baseline)
    pond = next(c for c in baseline.covers if c.cover_type == "water")
    inside = to_projected(pond.geometry).intersection(to_projected(polygon)).area
    assert inside > 1000
    session([cultivate(polygon)])

    at = scene.current_scene(CLEAR_YEAR)
    flagged = [c for c in at.covers if c.id == pond.id]
    assert flagged and flagged[0].cleared_by == "int-cultivate"  # still served, for the views of the current situation
    assert pond.id not in ids(at)[1]  # but not part of the simulation
    area = to_projected(polygon)
    water = [to_projected(c.geometry) for c in at.covers if c.cover_type == "water" and not c.cleared_by]
    assert water and sum(w.intersection(area).area for w in water) < 1.0  # none of it left under the area
    assert sum(w.area for w in water) == pytest.approx(to_projected(pond.geometry).area - inside, rel=0.01)
    fill = [c for c in at.covers if c.id == "cover-int-cultivate-fill-1"]
    assert fill and fill[0].cover_type == "lawn"  # the lawn the pond sits in
    assert to_projected(fill[0].geometry).area == pytest.approx(inside, rel=0.01)
    assert any(c.cover_type == "flowerbed" for c in at.covers)  # and the cultivation on top

    before = scene.current_scene(CLEAR_YEAR - 1)
    assert pond.id in {c.id for c in before.covers}
    assert at.indicators.space_use_pct["water"] < before.indicators.space_use_pct["water"]
    assert at.indicators.space_use_pct["flowerbed"] > 0


def test_a_path_is_cut_not_removed(baseline, session):
    polygon = across_pond(baseline)
    layout = build_layout(baseline, [])
    cut = [c for c in analyse(layout, polygon, CLEAR_YEAR).elements if c.type == "path"]
    assert cut
    def removed(c) -> float:
        original = project([layout.entries[c.entry].element.geometry])[0].length
        return original - (c.remainder.length if c.remainder is not None else 0)

    expected = sum(removed(c) for c in cut)
    assert expected > 0
    session([cultivate(polygon)])

    def length(t: int) -> float:
        paths = [e for e in scene.current_scene(t).elements if e.type == "path" and not e.cleared_by]
        return sum(to_projected(e.geometry).length for e in paths)

    assert length(CLEAR_YEAR - 1) - length(CLEAR_YEAR) == pytest.approx(expected, rel=0.001)
    pieces = [e for e in scene.current_scene(CLEAR_YEAR).elements if e.id.endswith("~int-cultivate")]
    assert pieces and all(e.source == "intervention" for e in pieces)


def test_cleared_baseline_objects_are_still_served_flagged(baseline, session):
    polygon = across_pond(baseline)
    layout = build_layout(baseline, [])
    cleared = {element_id(layout, c.entry) for c in analyse(layout, polygon, CLEAR_YEAR).elements if c.type != "path"}
    session([])
    plain = {e.id: e for e in scene.current_scene(CLEAR_YEAR + 3).elements}
    session([cultivate(polygon)])

    assert not [e for e in scene.current_scene(CLEAR_YEAR - 1).elements if e.cleared_by]  # nothing yet
    served = {e.id: e for e in scene.current_scene(CLEAR_YEAR + 3).elements}
    assert cleared <= served.keys()
    for id in cleared:
        assert served[id].cleared_by == "int-cultivate" and served[id].source == "baseline"
        # drawn as it is without the card (a tree keeps growing, or is cut, as it would have)
        assert served[id].properties == plain[id].properties
    assert not [e for e in served.values() if e.cleared_by and e.id not in cleared and e.type != "path"]


def test_what_a_card_placed_is_gone_not_flagged(baseline, session):
    spot = next(free_spots(baseline, 5.0))
    bench = card("add_bench", to_wgs84(spot), 0, "int-bench")
    session([bench, cultivate(square(spot, 5.0))])
    assert "element-int-bench" in {e.id for e in scene.current_scene(CLEAR_YEAR - 1).elements}
    assert "element-int-bench" not in {e.id for e in scene.current_scene(CLEAR_YEAR).elements}


def test_cleared_trees_stop_cooling_and_absorbing(baseline, session):
    session([])
    plain = scene.current_scene(CLEAR_YEAR + 5)
    session([cultivate(across_pond(baseline))])
    cleared = scene.current_scene(CLEAR_YEAR + 5)
    assert cleared.indicators.co2.annual_rate_kg < plain.indicators.co2.annual_rate_kg
    assert cleared.indicators.thermal_comfort.cooling_delta_c > plain.indicators.thermal_comfort.cooling_delta_c


def test_a_cleared_stump_goes_too(baseline, session):
    layout = build_layout(baseline, [])
    trees = [e for e in baseline.elements if e.type == "tree" and e.properties.get("cut_year") is not None]
    for tree, point in zip(trees, project([t.geometry for t in trees]), strict=True):
        year = tree.properties["cut_year"] + 3
        if year > scene.MAX_T or analyse(layout, square(point, 1.0), year).blocking:
            continue
        session([cultivate(square(point, 1.0), year)])
        stump = {e.id: e.properties["status"] for e in scene.current_scene(year - 1).elements if e.id == tree.id}
        assert stump == {tree.id: "stump"}
        assert tree.id not in ids(scene.current_scene(year))[0]
        return
    pytest.skip("no tree is cut early enough in the baseline")


def test_a_cleared_streetlight_stops_lighting_the_site(baseline, session):
    lamps = project([e.geometry for e in baseline.elements if e.type == "streetlight"])
    site = to_projected(baseline.site_boundary)
    min_x, min_y, max_x, max_y = site.bounds
    grid = (Point(x, y) for x in range(int(min_x), int(max_x), 5) for y in range(int(min_y), int(max_y), 5))
    far = sorted(grid, key=lambda p: -min(p.distance(lamp) for lamp in lamps))
    layout = build_layout(baseline, [])
    spot = next(p for p in far if site.contains(p) and not analyse(layout, square(p, 2.0), 0).blocking)
    lamp = card("add_streetlight", to_wgs84(spot), 0, "int-lamp")
    session([])
    plain = [scene.current_scene(t).indicators.social.safety_score for t in (0, CLEAR_YEAR + 1)]
    session([lamp, cultivate(square(spot, 2.0))])
    years = (0, CLEAR_YEAR - 1, CLEAR_YEAR, CLEAR_YEAR + 1)
    lit = [scene.current_scene(t).indicators.social.safety_score for t in years]
    assert lit[0] > plain[0] and lit[1] > plain[0]  # the placed lamp lights something...
    assert lit[2] == lit[3] == plain[1]  # ...until the clearing takes it away


def test_a_cleared_card_stops_counting_for_its_age_group(baseline, session):
    spot = next(free_spots(baseline, 10.0))
    playground = card("add_playground", square(spot, 3.0), 0, "int-playground", {"age_range": "junior"})
    session([playground])
    assert scene.current_scene(CLEAR_YEAR + 1).indicators.social.age_inclusivity.bambini
    session([playground, cultivate(square(spot, 10.0))])
    assert scene.current_scene(CLEAR_YEAR - 1).indicators.social.age_inclusivity.bambini
    assert not scene.current_scene(CLEAR_YEAR).indicators.social.age_inclusivity.bambini


def test_a_later_card_is_cleared_by_an_earlier_year_but_not_the_same_one(baseline, session):
    spot = next(free_spots(baseline, 5.0))
    polygon = square(spot, 5.0)
    bench_at = to_wgs84(spot)
    # Made after the clearing, but for the same year: it stays. For a later year: it stays too.
    same = card("add_bench", bench_at, CLEAR_YEAR, "int-bench-same")
    later = card("add_bench", bench_at, CLEAR_YEAR + 2, "int-bench-later")
    session([cultivate(polygon), same, later])
    assert {"element-int-bench-same", "element-int-bench-later"} <= ids(scene.current_scene(CLEAR_YEAR + 2))[0]
    # Made after the clearing, but for an earlier year: it was there first.
    earlier = card("add_bench", bench_at, CLEAR_YEAR - 2, "int-bench-earlier")
    session([cultivate(polygon), earlier])
    assert "element-int-bench-earlier" in ids(scene.current_scene(CLEAR_YEAR - 1))[0]
    assert "element-int-bench-earlier" not in ids(scene.current_scene(CLEAR_YEAR))[0]


def test_a_clearing_of_a_clearing(baseline, session):
    """A second card over the first one's cultivated cover replaces that too."""
    spot = next(free_spots(baseline, 6.0))
    first = cultivate(square(spot, 6.0), 3, "int-first")
    second = card("cultivate_terrain", square(spot, 3.0), 8, "int-second", {"purpose": "gardening"})
    session([first, second])
    def intervention_covers(t: int) -> dict[str, str]:
        return {c.id: c.cover_type for c in scene.current_scene(t).covers if c.source == "intervention"}

    assert "cover-int-first" in intervention_covers(7)
    assert "cover-int-first" not in intervention_covers(8)
    after = intervention_covers(8).values()
    assert "vegetable_garden" in after
    assert "flowerbed" in after  # what is left of the first, around the second


def test_without_a_clearing_card_nothing_has_an_end(baseline):
    spot = to_projected(baseline.site_boundary).representative_point()
    layout = build_layout(baseline, [card("add_bench", to_wgs84(spot), 0, "int-b")])
    apply_clearing(layout)
    assert all(e.end is None and e.cleared_by is None for e in layout.entries)
    assert all(t.clear_year is None for t in layout.trees)
