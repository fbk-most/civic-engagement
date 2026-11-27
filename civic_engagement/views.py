"""The views of a participatory process: what a screen shows (the core's
README, "Teams").

A view is a named set of the core's panels, with the tab it opens on and
how the interventions are shown when it doesn't offer the switch. A pack's
views (`ViewSpec`, `DomainPack.views`) are named by its phases (`PhaseSpec.
views`, the first the phase's default); the frontend picks one from the
URL (`#view=<id>`, frontend/src/views.ts). A view only hides: changing
something is the role's and the phase's (phases.py).

A pack without views (the default), or a phase without any, shows
everything.
"""

from civic_engagement.models.schema import PhaseSpec, ViewSpec

# Every panel a view can show. `notes`, `compare` and `export` are for
# what is still to come: allowed, nothing shown by them yet.
PANELS = (
    "tab.2d",  # the tabs offered
    "tab.3d",
    "tab.indicators",
    "kpi",  # key indicators
    "thermal",  # the felt-temperature panel and field
    "time",  # the year slider (and the 3D view's time panel)
    "legend",  # the map's legend
    "notes",  # the needs
    "cards",  # the card palette: placing and changing cards (also needs the phase)
    "interventions",  # the placed interventions' list
    "interventionMode",  # the as-is / cards / simulation switch
    "scenarios",  # the scenario menu (also needs the phase)
    "compare",  # two scenarios side by side
    "export",  # image download
)


def check(views: list[ViewSpec], phases: list[PhaseSpec]) -> None:
    """A pack's views, at registration: ids unique, panels known, the
    opening tab among them; every view a phase names, there."""
    ids = [view.id for view in views]
    if len(set(ids)) != len(ids):
        raise ValueError(f"Views with the same id: {ids}")
    for view in views:
        unknown = set(view.panels) - set(PANELS)
        if unknown:
            raise ValueError(f"View {view.id!r}: unknown panels {sorted(unknown)}, not among {list(PANELS)}")
        if f"tab.{view.tab}" not in view.panels:
            raise ValueError(f"View {view.id!r} opens on the tab {view.tab!r}, not among its panels")
    for phase in phases:
        missing = [view for view in phase.views if view not in ids]
        if missing:
            raise ValueError(f"Phase {phase.id!r}: no views {missing} among the pack's ({', '.join(ids) or 'none'})")
