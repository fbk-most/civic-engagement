"""The domain pack: everything the core needs from a domain (urban, rural,
...), which lives in its own package and builds its app on the core
(`civic_engagement.app.create_app`).

A pack declares its sites, cards, element and cover types, indicators and
uncontrollables (none, for some packs), and evaluates a scenario: the
baseline plus a set of interventions, under one value of each
uncontrollable, over the whole horizon at once. The core caches the evaluations, assembles the scene
for a year from them and serves it, with the sessions and the scenarios.

One pack per process, registered before anything reads the active site or
the pack (`register`, which `create_app` calls): the core's modules may be
imported before, but `civic_engagement.scene`, `store` and `api` read them
when imported.
"""

import inspect
from abc import ABC, abstractmethod
from typing import Any

from fastapi import APIRouter

from civic_engagement.config import SiteConfig
from civic_engagement.models.schema import (
    BaselineScene,
    CardSpec,
    CoverPolygon,
    DiscreteElement,
    IndicatorDescriptors,
    IndicatorValues,
    Intervention,
    InterventionCreate,
    Uncontrollables,
    UncontrollableSpec,
)
from civic_engagement.pins import DigitPin, PinFormat


class DomainPack(ABC):
    id: str
    sites: dict[str, SiteConfig]
    default_site: str
    # Years after now that a scenario covers: t is in 0..horizon_years.
    horizon_years: int
    cards: list[CardSpec]
    element_types: frozenset[str]
    cover_types: frozenset[str]
    indicators: IndicatorDescriptors
    # What a scenario assumes but nobody at the table decides; a pack with
    # some takes their values in `evaluate`.
    uncontrollables: list[UncontrollableSpec] = []
    # The PINs' format, with teams (CIVIC_ENGAGEMENT_AUTH=pin): see pins.py.
    pin_format: PinFormat = DigitPin()

    @abstractmethod
    def evaluate(self, baseline: BaselineScene, interventions: list[Intervention]) -> Any:
        """The scenario over the whole horizon. Opaque to the core, which
        caches it and hands it back to `assemble` and `indicator_values`.

        A pack with uncontrollables adds a keyword parameter
        `uncontrollables: Uncontrollables | None = None`, which the core
        passes with every one's value (`settled`); to a pack without, it
        never passes it."""

    def settled(self, chosen: Uncontrollables) -> Uncontrollables:
        """Every uncontrollable's value: the chosen one, or the default for
        those not chosen, or chosen as a value it doesn't have (a scenario
        saved before the pack changed). Others are dropped."""
        return {
            spec.id: chosen[spec.id] if chosen.get(spec.id) in {v.id for v in spec.values} else spec.default
            for spec in self.uncontrollables
        }

    def refused(self, chosen: Uncontrollables) -> str | None:
        """Why `chosen` isn't a setting of the uncontrollables (an unknown
        one, or a value it doesn't have), or None if it is."""
        specs = {spec.id: spec for spec in self.uncontrollables}
        for name, value in chosen.items():
            if name not in specs:
                return f"Unknown uncontrollable {name!r}"
            if value not in {v.id for v in specs[name].values}:
                return f"{name}: {value!r} isn't one of its values"
        return None

    @abstractmethod
    def assemble(self, evaluation: Any, t: int) -> tuple[list[DiscreteElement], list[CoverPolygon]]:
        """The scene's elements and covers at year t."""

    @abstractmethod
    def indicator_values(self, evaluation: Any, t: int) -> IndicatorValues:
        """Every indicator but the deferred ones, at year t."""

    def refused_intervention(self, intervention: InterventionCreate) -> tuple[str, str] | None:
        """Why the pack refuses a card about to be placed, or its new
        parameters (say, a card for houses on a barn): in Italian and in
        English, shown to the team as is; or None. The core has already
        checked what it can: the card type, the boundary, the buildings
        picked."""
        return None

    def deferred_values(self, interventions: list[Intervention], t: int) -> IndicatorValues:
        """The deferred indicators at year t (see IndicatorDescriptor), too
        slow for the scene. A pack with some overrides this and
        `deferred_series`."""
        return {}

    def deferred_series(self, interventions: list[Intervention], years: list[int]) -> list[IndicatorValues]:
        return [self.deferred_values(interventions, t) for t in years]

    def routers(self) -> list[APIRouter]:
        """The pack's own API routes, served under /api next to the core's."""
        return []


_pack: DomainPack | None = None


def register(pack: DomainPack) -> None:
    global _pack
    if _pack is not None and _pack is not pack:
        raise RuntimeError(f"A domain pack ({_pack.id!r}) is already registered")
    # At startup rather than at the first request (see `DomainPack.evaluate`).
    if pack.uncontrollables and "uncontrollables" not in inspect.signature(pack.evaluate).parameters:
        raise TypeError(f"Domain pack {pack.id!r} declares uncontrollables, but its evaluate takes no 'uncontrollables'")
    _pack = pack


def active_pack() -> DomainPack:
    if _pack is None:
        raise RuntimeError(
            "No domain pack registered: call civic_engagement.domain.register(pack) "
            "(or build the app with civic_engagement.app.create_app) first"
        )
    return _pack
