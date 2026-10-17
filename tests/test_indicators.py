"""The indicator values served match their descriptors: one descriptor per
value, of the declared kind, deferred ones served apart from the scene."""

from civic_engagement.scene import current_scene, deferred_indicators, indicator_descriptors, indicator_series


def _kind(value) -> str:
    if isinstance(value, dict):
        return "flags" if all(isinstance(v, bool) for v in value.values()) else "breakdown"
    return "number"


def test_values_match_descriptors():
    descriptors = indicator_descriptors()
    by_id = {d.id: d for d in descriptors.indicators}
    assert len(by_id) == len(descriptors.indicators), "duplicate descriptor ids"
    assert {d.group for d in descriptors.indicators} <= {g.id for g in descriptors.groups}

    deferred = {d.id for d in descriptors.indicators if d.deferred}
    scene = current_scene(0)
    assert set(scene.indicators) == set(by_id) - deferred
    assert set(scene.baseline_indicators) == set(by_id) - deferred
    slow = deferred_indicators(0)
    assert set(slow.scenario) == set(slow.baseline) == deferred

    for values in (scene.indicators, slow.scenario):
        for id, value in values.items():
            assert value is None or _kind(value) == by_id[id].kind, id
    for id in (d.id for d in descriptors.indicators if d.kind == "flags"):
        assert set(scene.indicators[id]) == {p.id for p in by_id[id].parts}


def test_series_has_every_indicator():
    series = indicator_series()
    ids = {d.id for d in indicator_descriptors().indicators}
    assert all(set(values) == ids for values in series.baseline + series.scenario)
