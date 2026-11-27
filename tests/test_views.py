"""Views (civic_engagement/views.py): declared by the pack, checked when it
registers, and told to the frontend (GET /views, the phase's in /auth/me)."""

import pytest

from civic_engagement import domain
from civic_engagement.domain import active_pack
from civic_engagement.models.schema import PhaseSpec, ViewSpec
from civic_engagement.views import PANELS, check

# The toy pack's phases and views (with `app` and `open_app`): test_phases.py's.
from tests.test_phases import PHASES, VIEWS, _set, _team, app, open_app, phased  # noqa: F401 (fixtures)
from tests.test_teams import ADMIN, pin_app  # noqa: F401 (a fixture)


def test_views_checked_when_the_pack_registers(monkeypatch):
    check(VIEWS, PHASES)
    check([], [])  # neither: everything shown
    check([], [PhaseSpec(id="x", label="X", label_en="X")])  # a phase without views
    with pytest.raises(ValueError, match="same id"):
        check([VIEWS[0], VIEWS[0]], [])
    with pytest.raises(ValueError, match=r"unknown panels \['map'\]"):
        check([ViewSpec(id="x", label="X", label_en="X", panels=["tab.2d", "map"])], [])
    with pytest.raises(ValueError, match="opens on the tab '3d'"):
        check([ViewSpec(id="x", label="X", label_en="X", panels=["tab.2d"], tab="3d")], [])
    with pytest.raises(ValueError, match=r"Phase 'looking': no views \['as-is'\]"):
        check(VIEWS[1:], PHASES)
    # Every panel is one a view may show, those without a UI yet too.
    check([ViewSpec(id="all", label="Tutto", label_en="All", panels=list(PANELS))], [])

    class Broken(type(active_pack())):
        phases = PHASES
        views = VIEWS[1:]

    monkeypatch.setattr(domain, "_pack", None)
    with pytest.raises(ValueError, match="no views"):
        domain.register(Broken())
    assert domain._pack is None


def test_the_views_reach_the_frontend(app):
    team, editor, viewers = _team(app)
    views = app.get("/api/views", headers=viewers).json()
    assert [view["id"] for view in views] == ["as-is", "cards"]
    assert (views[0]["tab"], views[0]["intervention_mode"]) == ("2d", "hidden")
    assert (views[1]["tab"], views[1]["intervention_mode"]) == ("3d", "simulated")
    assert app.get("/api/views").status_code == 401  # a member's, like the cards
    assert app.get("/api/admin/views", headers=ADMIN).json() == views

    # The phase's views, in /auth/me, for editors and viewers alike.
    assert app.get("/api/auth/me", headers=viewers).json()["views"] == ["as-is"]
    _set(app, team["id"], "placing")
    assert app.get("/api/auth/me", headers=editor).json()["views"] == ["cards"]


def test_a_pack_without_views(pin_app):  # noqa: F811
    """The toy pack as it is: no phases, no views; everything shown."""
    _, editor, _ = _team(pin_app)
    assert pin_app.get("/api/views", headers=editor).json() == []
    assert pin_app.get("/api/auth/me", headers=editor).json()["views"] == []


def test_the_open_mechanism(open_app):  # noqa: F811
    # No phase: no views of its own (any of the pack's may be asked for).
    assert open_app(None).get("/api/auth/me").json()["views"] == []
    assert open_app("looking").get("/api/auth/me").json()["views"] == ["as-is"]
    assert [view["id"] for view in open_app(None).get("/api/views").json()] == ["as-is", "cards"]
