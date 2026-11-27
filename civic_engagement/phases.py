"""The phases of a participatory process: which changes the server accepts
now (the core's README, "Teams").

The core names the operations it can block; a pack's phase (`PhaseSpec`,
`DomainPack.phases`) is the set it allows. A change goes through only if
the member's role (an editor) and the team's phase allow it (access.py,
`allowed`); reading is never blocked.

Where a team's phase lives:
- `pin`: in teams.json (store/teams.py), set by the manager
  (api/routes_admin.py); a new team starts in the pack's first phase.
- `open`: `CIVIC_ENGAGEMENT_PHASE=<id>`, for the one team; unset, nothing
  is blocked.

A pack without phases (the default) blocks nothing: the phase is None
everywhere.
"""

import os

from civic_engagement.models.schema import PhaseSpec

NOTES_EDIT = "notes.edit"
INTERVENTIONS_EDIT = "interventions.edit"
SCENARIOS_EDIT = "scenarios.edit"

# Every operation the core can block, in the order the API lists them.
OPERATIONS = (NOTES_EDIT, INTERVENTIONS_EDIT, SCENARIOS_EDIT)


def check(phases: list[PhaseSpec]) -> None:
    """A pack's phases, at registration: ids unique, operations known."""
    ids = [phase.id for phase in phases]
    if len(set(ids)) != len(ids):
        raise ValueError(f"Phases with the same id: {ids}")
    for phase in phases:
        unknown = set(phase.operations) - set(OPERATIONS)
        if unknown:
            raise ValueError(f"Phase {phase.id!r}: unknown operations {sorted(unknown)}, not among {list(OPERATIONS)}")


def operations(phases: list[PhaseSpec], phase: str | None) -> list[str]:
    """What a phase allows: everything with no phase (None), nothing for
    one the pack doesn't have."""
    if phase is None:
        return list(OPERATIONS)
    found = next((p for p in phases if p.id == phase), None)
    return [op for op in OPERATIONS if found and op in found.operations]


def open_phase(phases: list[PhaseSpec]) -> str | None:
    """The phase with the `open` mechanism: `CIVIC_ENGAGEMENT_PHASE`, or
    None (nothing blocked). One the pack doesn't have is an error (the app
    refuses to start: access.check_configuration)."""
    phase = os.environ.get("CIVIC_ENGAGEMENT_PHASE") or None
    if phase is not None and phase not in {p.id for p in phases}:
        known = ", ".join(p.id for p in phases) or "none: the pack has no phases"
        raise RuntimeError(f"CIVIC_ENGAGEMENT_PHASE={phase!r}: not one of the pack's phases ({known})")
    return phase
