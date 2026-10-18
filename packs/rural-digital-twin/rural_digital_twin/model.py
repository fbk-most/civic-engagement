"""A stub of the rural model, standing in until the real one (growth,
disturbances, timber...) exists. It works on stands (see stands.py), in
time order:

- felling removes the forest within its area — the baseline stands and
  any earlier planting — and leaves a clearing;
- planting adds a young stand of its species, which ages year by year.

The indicators are the forest's area and the areas planted and felled.
"""

from dataclasses import dataclass

import geopandas as gpd
import shapely
from shapely.geometry import mapping, shape
from shapely.geometry.base import BaseGeometry

from civic_engagement.config import PROJECTED_CRS, WGS84_CRS
from civic_engagement.models.schema import BaselineScene, CoverPolygon, DiscreteElement, Intervention
from rural_digital_twin.stands import planting_properties

FOREST_TYPES = {"forest", "planting"}


def _utm(geojson: dict) -> BaseGeometry:
    return gpd.GeoSeries([shape(geojson)], crs=WGS84_CRS).to_crs(PROJECTED_CRS).iloc[0]


def _wgs84(geometry: BaseGeometry) -> dict:
    return mapping(shapely.set_precision(gpd.GeoSeries([geometry], crs=PROJECTED_CRS).to_crs(WGS84_CRS).iloc[0], 1e-7))


@dataclass(frozen=True)
class State:
    """The covers from year `start` on, until the next state: each with its
    geometry in UTM."""

    start: int
    covers: list[tuple[CoverPolygon, BaseGeometry]]
    planted_ha: float
    felled_ha: float


@dataclass(frozen=True)
class Evaluated:
    states: list[State]


def evaluate(baseline: BaselineScene, interventions: list[Intervention]) -> Evaluated:
    covers = [(c, _utm(c.geometry)) for c in baseline.covers]
    states = [State(0, covers, 0.0, 0.0)]
    planted = felled = 0.0
    live = [iv for iv in interventions if not iv.deleted and iv.card_type in ("plant_forest", "fell_forest")]
    for iv in sorted(live, key=lambda iv: (iv.planted_year, iv.created_at)):
        area = _utm(iv.geometry)
        if iv.card_type == "fell_forest":
            kept = []
            for cover, geometry in covers:
                if cover.cover_type in FOREST_TYPES and geometry.intersects(area):
                    felled += geometry.intersection(area).area / 10_000
                    geometry = geometry.difference(area)
                    if geometry.is_empty:
                        continue
                    cover = cover.model_copy(update={"geometry": _wgs84(geometry)})
                kept.append((cover, geometry))
            covers = kept + [(_cover(iv, "felling", {}), area)]
        else:
            planted += area.area / 10_000
            covers = covers + [(_cover(iv, "planting", planting_properties(iv.params.get("species", "mixed"), iv.planted_year)), area)]
        if states[-1].start == iv.planted_year:
            states.pop()
        states.append(State(iv.planted_year, covers, planted, felled))
    return Evaluated(states)


def _cover(iv: Intervention, cover_type: str, properties: dict) -> CoverPolygon:
    return CoverPolygon(
        id=f"cover-{iv.id}", geometry=iv.geometry, cover_type=cover_type, properties=properties,
        source="intervention", intervention_id=iv.id,
    )


def state_at(evaluated: Evaluated, t: int) -> State:
    return next(s for s in reversed(evaluated.states) if s.start <= t)


def assemble(evaluated: Evaluated, t: int) -> tuple[list[DiscreteElement], list[CoverPolygon]]:
    covers = []
    for cover, _ in state_at(evaluated, t).covers:
        if cover.cover_type == "planting":
            cover = cover.model_copy(update={"properties": {**cover.properties, "age_years": t - cover.properties["planted_year"]}})
        covers.append(cover)
    return [], covers


def forest_ha(evaluated: Evaluated, t: int) -> float:
    return sum(g.area for c, g in state_at(evaluated, t).covers if c.cover_type in FOREST_TYPES) / 10_000
