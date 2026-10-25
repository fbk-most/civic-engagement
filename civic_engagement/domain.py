"""The domain pack: everything the core needs from a domain (urban, rural,
...), which lives in its own package and builds its app on the core
(`civic_engagement.app.create_app`).

A pack declares its sites, cards, element and cover types and indicators,
and evaluates a scenario: the baseline plus a set of interventions, over the
whole horizon at once. The core caches the evaluations, assembles the scene
for a year from them and serves it, with the sessions and the scenarios.

One pack per process, registered before anything reads the active site or
the pack (`register`, which `create_app` calls): the core's modules may be
imported before, but `civic_engagement.scene`, `store` and `api` read them
when imported.
"""

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
    # The PINs' format, with teams (CIVIC_ENGAGEMENT_AUTH=pin): see pins.py.
    pin_format: PinFormat = DigitPin()

    @abstractmethod
    def evaluate(self, baseline: BaselineScene, interventions: list[Intervention]) -> Any:
        """The scenario over the whole horizon. Opaque to the core, which
        caches it and hands it back to `assemble` and `indicator_values`."""

    @abstractmethod
    def assemble(self, evaluation: Any, t: int) -> tuple[list[DiscreteElement], list[CoverPolygon]]:
        """The scene's elements and covers at year t."""

    @abstractmethod
    def indicator_values(self, evaluation: Any, t: int) -> IndicatorValues:
        """Every indicator but the deferred ones, at year t."""

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
    _pack = pack


def active_pack() -> DomainPack:
    if _pack is None:
        raise RuntimeError(
            "No domain pack registered: call civic_engagement.domain.register(pack) "
            "(or build the app with civic_engagement.app.create_app) first"
        )
    return _pack
