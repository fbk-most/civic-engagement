"""Felt temperature across the site, hour by hour through one day, as a
civic-digital-twins model.

One evaluation is one scenario at one year (the scene as served for that
year, turned into rasters by field_grid.py) on one day (the sun and the
weather of that date, from solar.py): felt temperature at 1.1 m above the
ground in every 1 m cell of the site, for each of the 24 hours, plus a few
summaries over the site's open space (inside the boundary, outside
buildings).

Felt temperature is a cheap proxy (see the parameters in parameters.py):

    air temperature
    + sun on a person:   SUN_GAIN × how much direct sun reaches the cell
    + ground heat:       what the cell's surface stores of the sun it gets,
                         fading by GROUND_HEAT_RETENTION each hour, around
                         the clock (the day repeats)
    + evaporation:       constant cooling of lawn and meadow
    + water:             ponds and fountains cooling the air around them
                         on warm days, fading with distance
    + canopy:            cooling under a crown in leaf

How much sun reaches a cell is the one black-box part (`sun_exposure`, a
functor): a ray from the cell towards the sun, stopped by buildings and
dimmed by the tree crowns and pergola roofs it crosses.

Unlike the yearly model (model.py), this one is evaluated on demand, for
the year and date asked about.
"""

import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date

import numpy as np
from civic_digital_twins.dt_model import (
    DomainAxis,
    EvaluationResult,
    Functor,
    Index,
    Model,
    ModelEvaluator,
    ModelOutput,
    ParameterMeta,
    Scenario,
    SpaceType,
    define,
    functions,
    graph,
    inputs,
    outputs,
)
from civic_digital_twins.dt_model.simulation.runner import EvaluationConfig

from bologna_civic_dt import cdt_compat
from bologna_civic_dt.field_grid import FieldRasters
from bologna_civic_dt.parameters import (
    CANOPY_COOLING_C,
    CROWN_EXTINCTION_BARE_PER_M,
    CROWN_EXTINCTION_LEAFY_PER_M,
    FIELD_CELL_M,
    FOUNTAIN_COOLING_C,
    FOUNTAIN_HALF_DISTANCE_M,
    GROUND_HEAT_C,
    GROUND_HEAT_RETENTION,
    HEAT_STRESS_C,
    PERGOLA_EXTINCTION_PER_M,
    PERSON_HEIGHT_M,
    SUN_GAIN_C_PER_KW,
    SURFACE_COOLING_C,
    SURFACES,
    WATER_COOLING_C,
    WATER_COOLING_FROM_C,
    WATER_COOLING_FULL_C,
    WATER_HALF_DISTANCE_M,
)
from bologna_civic_dt.solar import HOURS, Day

# --- axes ---------------------------------------------------------------------------

HOUR = DomainAxis("hour")
SURFACE = DomainAxis("surface")
# The field grid, and the (larger) occluder grid around it — see field_grid.py.
GY = DomainAxis("grid_y", type=SpaceType(spacing=FIELD_CELL_M))
GX = DomainAxis("grid_x", type=SpaceType(spacing=FIELD_CELL_M))
OY = DomainAxis("occluder_y", type=SpaceType(spacing=FIELD_CELL_M))
OX = DomainAxis("occluder_x", type=SpaceType(spacing=FIELD_CELL_M))

LAYOUT_AXES = (HOUR, SURFACE, GY, GX, OY, OX)

FIELD = (HOUR, GY, GX)
GRID = (GY, GX)
OCCLUDERS = (OY, OX)

# Axes of every per-evaluation input — what `field_inputs` produces.
INPUT_AXES: dict[str, tuple] = {
    "air_temperature": (HOUR,),
    "sun_altitude": (HOUR,),
    "sun_azimuth": (HOUR,),
    "direct_kw": (HOUR,),
    "ground_kw": (HOUR,),
    "leaf_density": (),
    "open": GRID,
    "surface": (SURFACE, GY, GX),
    "canopy_deciduous": GRID,
    "canopy_evergreen": GRID,
    "water_distance": GRID,
    "fountain_distance": GRID,
    "building_height": OCCLUDERS,
    "crown_low": OCCLUDERS,
    "crown_high": OCCLUDERS,
    "deciduous": OCCLUDERS,
    "evergreen": OCCLUDERS,
    "pergola": OCCLUDERS,
}


# --- the black box: how much sun reaches each cell ------------------------------------

# Ray-marching step, in cells.
STEP = 1.0
# Below this the sun is too low to count (and the march too long).
MIN_ALTITUDE_DEG = 1.0


def sun_exposure(altitude, azimuth, building_height, crown_low, crown_high, extinction, open_, person_height):
    """Per hour and field cell: the share of direct sun reaching a person
    standing there (0-1). Axes: (hour, grid_y, grid_x).

    From each cell, at `person_height`, a ray goes towards the sun in
    one-cell steps across the occluder grid: a building taller than the
    ray stops it; a crown band the ray crosses dims it by
    exp(-extinction × path length inside the band). Beyond the occluder
    grid nothing is known, and the ray goes on unobstructed.

    Only the open cells get a ray (elsewhere the field is NaN anyway), and a
    ray stops as soon as a building blocks it or it leaves the grid: it
    can't come back."""
    oy, ox = building_height.shape
    gy, gx = open_.shape
    my, mx = (oy - gy) // 2, (ox - gx) // 2
    traced = np.flatnonzero(np.asarray(open_).ravel() > 0.5)
    jj = traced // gx + my + 0.5
    ii = traced % gx + mx + 0.5
    flat = {
        name: np.asarray(a, dtype=np.float32).ravel()
        for name, a in (("height", building_height), ("low", crown_low), ("high", crown_high), ("ext", extinction))
    }
    top = max(float(building_height.max()), float(crown_high.max())) - float(person_height)

    def one_hour(alt: float, az: float) -> np.ndarray:
        out = np.zeros(gy * gx, dtype=np.float32)
        if alt < MIN_ALTITUDE_DEG:
            return out
        alt_r = math.radians(alt)
        sin_a = math.sin(alt_r)
        dx, dy = math.sin(math.radians(az)), math.cos(math.radians(az))
        rise = STEP * FIELD_CELL_M * math.tan(alt_r)  # metres climbed per step
        steps = min(math.ceil(top / rise) + 1, math.ceil(math.hypot(oy, ox) / STEP)) if top > 0 else 0
        n = len(traced)
        blocked = np.zeros(n, dtype=bool)
        depth = np.zeros(n, dtype=np.float32)  # extinction × path length so far
        # The rays still marching, as positions into the arrays above.
        active = np.arange(n)
        # Step 0 is the cell itself: straight up, as far as the ray climbs
        # before it leaves the cell (all the way, with the sun overhead).
        for s in range(steps + 1):
            col = np.floor(ii[active] + s * STEP * dx).astype(np.int32)
            row = np.floor(jj[active] + s * STEP * dy).astype(np.int32)
            within = (col >= 0) & (col < ox) & (row >= 0) & (row < oy)
            active, col, row = active[within], col[within], row[within]
            if len(active) == 0:
                break
            index = row * ox + col
            z = person_height + s * rise
            wall = flat["height"][index] > z
            blocked[active[wall]] = True
            bottom, top_z = max(z - rise / 2, person_height), z + rise / 2
            low, high = flat["low"][index], flat["high"][index]
            crossing = (high > bottom) & (low < top_z)
            if crossing.any():
                overlap = np.minimum(top_z, high[crossing]) - np.maximum(bottom, low[crossing])
                depth[active[crossing]] += flat["ext"][index[crossing]] * np.clip(overlap, 0, None)
            active = active[~wall]
        out[traced] = np.where(blocked, 0.0, np.exp(-depth / sin_a))
        return out

    # Hours are independent, and numpy mostly runs without the GIL.
    with ThreadPoolExecutor() as pool:
        out = np.stack(list(pool.map(one_hour, altitude, azimuth)))
    return out.reshape(len(altitude), gy, gx).astype(float)


# --- the model ------------------------------------------------------------------------


def _lookup(onehot, table, axis):
    return (onehot * table).sum(axis=axis)


def _over_open(value, open_):
    """Sum over the open cells, per hour."""
    return graph.where(open_ > 0.5, value, 0.0).sum(axis=GY).sum(axis=GX)


@define("FeltTemperatureField")
class FeltTemperatureField(Model):
    @inputs
    class Inputs:
        # per evaluation (see INPUT_AXES)
        air_temperature: Index  # (hour,)
        sun_altitude: Index  # (hour,), degrees
        sun_azimuth: Index  # (hour,), degrees clockwise from north
        direct_kw: Index  # (hour,), direct beam facing the sun, kW/m²
        ground_kw: Index  # (hour,), direct beam on level ground, kW/m²
        leaf_density: Index  # 0-1, deciduous trees
        open: Index  # (grid_y, grid_x)
        surface: Index  # (surface, grid_y, grid_x), one-hot
        canopy_deciduous: Index  # (grid_y, grid_x)
        canopy_evergreen: Index  # (grid_y, grid_x)
        water_distance: Index  # (grid_y, grid_x), m
        fountain_distance: Index  # (grid_y, grid_x), m
        building_height: Index  # (occluder_y, occluder_x)
        crown_low: Index  # (occluder_y, occluder_x)
        crown_high: Index  # (occluder_y, occluder_x)
        deciduous: Index  # (occluder_y, occluder_x)
        evergreen: Index  # (occluder_y, occluder_x)
        pergola: Index  # (occluder_y, occluder_x)
        # parameters (see parameters.py)
        person_height: Index
        sun_gain: Index
        extinction_leafy: Index
        extinction_bare: Index
        extinction_pergola: Index
        ground_heat: Index  # (surface,)
        ground_retention: Index
        surface_cooling: Index  # (surface,)
        canopy_cooling: Index
        water_cooling: Index
        water_half_distance: Index
        fountain_cooling: Index
        fountain_half_distance: Index
        water_cooling_from: Index
        water_cooling_full: Index
        heat_stress: Index

    @outputs
    class Outputs:
        felt: Index  # (hour, grid_y, grid_x); NaN outside the open space
        exposure: Index  # (hour, grid_y, grid_x), 0-1
        # Over the open space, per hour:
        mean_felt: Index  # (hour,)
        heat_stress_pct: Index  # (hour,) % of it at or above HEAT_STRESS_C
        sunlit_pct: Index  # (hour,) % of it in the sun (exposure above 0.5)

    @functions
    class Functions:
        sun_exposure: Functor

    def compute(self, inputs: Inputs, *, fns: Functions) -> Outputs:
        i = inputs
        extinction = Index(
            "crown extinction",
            i.deciduous * (i.extinction_bare + (i.extinction_leafy - i.extinction_bare) * i.leaf_density)
            + i.evergreen * i.extinction_leafy
            + i.pergola * i.extinction_pergola,
            axes=OCCLUDERS,
        )
        exposure = Index(
            "sun exposure",
            graph.function_call(
                "sun_exposure", i.sun_altitude, i.sun_azimuth, i.building_height, i.crown_low, i.crown_high,
                extinction, i.open, i.person_height, functor=fns.sun_exposure,
            ),
            axes=FIELD,
        )
        sun = Index("sun on a person", i.sun_gain * exposure * i.direct_kw, axes=FIELD)

        # The ground's store of heat: this hour's sun plus what is left of
        # the earlier hours', the day repeating (a periodic recurrence,
        # summed in closed form over one cycle).
        absorbed = Index("sun on the ground", exposure * i.ground_kw, axes=FIELD)
        r = i.ground_retention
        stored = absorbed.node
        for k in range(1, HOURS):
            stored = stored + absorbed.node.roll(HOUR, k) * r**k
        store = Index("ground heat store", stored * (1 - r) / (1 - r**HOURS), axes=FIELD)

        heat = Index("ground heat", _lookup(i.surface, i.ground_heat, SURFACE), axes=GRID)
        evaporation = Index("evaporation", _lookup(i.surface, i.surface_cooling, SURFACE), axes=GRID)
        leafy = i.canopy_deciduous * i.leaf_density + i.canopy_evergreen
        canopy = Index("canopy cooling", i.canopy_cooling * graph.where(leafy > 1.0, 1.0, leafy), axes=GRID)

        # Halving every `half` metres: exp(-d ln2 / half).
        near_water = graph.exp(i.water_distance * (-math.log(2)) / i.water_half_distance)
        near_fountain = graph.exp(i.fountain_distance * (-math.log(2)) / i.fountain_half_distance)
        warmth = (i.air_temperature - i.water_cooling_from) / (i.water_cooling_full - i.water_cooling_from)
        warm = Index("warm enough for water to cool", graph.where(warmth < 0.0, 0.0, graph.where(warmth > 1.0, 1.0, warmth)), axes=(HOUR,))
        water = Index(
            "water cooling", warm * (i.water_cooling * near_water + i.fountain_cooling * near_fountain), axes=FIELD
        )

        raw = Index(
            "felt temperature, all cells",
            i.air_temperature + sun + heat * store + evaporation + canopy + water,
            axes=FIELD,
        )
        felt = Index("felt temperature", graph.where(i.open > 0.5, raw, np.nan), axes=FIELD)

        n_open = _over_open(1.0, i.open)
        return FeltTemperatureField.Outputs(
            felt=felt,
            exposure=exposure,
            mean_felt=Index("mean felt temperature", _over_open(raw, i.open) / n_open, axes=(HOUR,)),
            heat_stress_pct=Index(
                "heat stress pct", 100 * _over_open(graph.where(raw >= i.heat_stress, 1.0, 0.0), i.open) / n_open,
                axes=(HOUR,),
            ),
            sunlit_pct=Index(
                "sunlit pct", 100 * _over_open(graph.where(exposure > 0.5, 1.0, 0.0), i.open) / n_open, axes=(HOUR,)
            ),
        )


def _table(name: str, table: dict[str, float]) -> Index:
    return Index(name, np.array([table.get(s, 0.0) for s in SURFACES]), axes=(SURFACE,))


def build_field_model() -> FeltTemperatureField:
    """The model, with every per-evaluation input left open and every
    parameter at its parameters.py value."""

    def open_input(name: str) -> Index:
        axes = INPUT_AXES[name]
        return Index(name, None, axes=axes) if axes else Index(name, None)

    parameters = {
        "person_height": Index("person height", PERSON_HEIGHT_M),
        "sun_gain": Index("sun gain per kW", SUN_GAIN_C_PER_KW),
        "extinction_leafy": Index("crown extinction in leaf", CROWN_EXTINCTION_LEAFY_PER_M),
        "extinction_bare": Index("crown extinction bare", CROWN_EXTINCTION_BARE_PER_M),
        "extinction_pergola": Index("pergola extinction", PERGOLA_EXTINCTION_PER_M),
        "ground_heat": _table("ground heat", GROUND_HEAT_C),
        "ground_retention": Index("ground heat retention", GROUND_HEAT_RETENTION),
        "surface_cooling": _table("surface cooling", SURFACE_COOLING_C),
        "canopy_cooling": Index("canopy cooling", CANOPY_COOLING_C),
        "water_cooling": Index("water cooling", WATER_COOLING_C),
        "water_half_distance": Index("water cooling half distance", WATER_HALF_DISTANCE_M),
        "fountain_cooling": Index("fountain cooling", FOUNTAIN_COOLING_C),
        "fountain_half_distance": Index("fountain cooling half distance", FOUNTAIN_HALF_DISTANCE_M),
        "water_cooling_from": Index("water cooling from", WATER_COOLING_FROM_C),
        "water_cooling_full": Index("water cooling full", WATER_COOLING_FULL_C),
        "heat_stress": Index("heat stress threshold", HEAT_STRESS_C),
    }
    functors = FeltTemperatureField.Functions(
        sun_exposure=cdt_compat.on_axes(
            sun_exposure,
            [(HOUR,), (HOUR,), OCCLUDERS, OCCLUDERS, OCCLUDERS, OCCLUDERS, GRID, ()],
            FIELD,
            LAYOUT_AXES,
        ),
    )
    return FeltTemperatureField(
        inputs=FeltTemperatureField.Inputs(**{n: open_input(n) for n in INPUT_AXES}, **parameters), fns=functors
    )


def field_inputs(rasters: FieldRasters, day: Day) -> dict[str, np.ndarray]:
    """The per-evaluation inputs, from a scene's rasters and a day."""
    return {
        "air_temperature": day.air_temperature,
        "sun_altitude": day.altitude,
        "sun_azimuth": day.azimuth,
        "direct_kw": day.direct / 1000,
        "ground_kw": day.direct / 1000 * np.sin(np.radians(np.clip(day.altitude, 0, None))),
        "leaf_density": np.array(day.leaf_density),
        "open": rasters.open,
        "surface": rasters.surface,
        "canopy_deciduous": rasters.canopy_deciduous,
        "canopy_evergreen": rasters.canopy_evergreen,
        "water_distance": rasters.water_distance,
        "fountain_distance": rasters.fountain_distance,
        "building_height": rasters.building_height,
        "crown_low": rasters.crown_low,
        "crown_high": rasters.crown_high,
        "deciduous": rasters.deciduous,
        "evergreen": rasters.evergreen,
        "pergola": rasters.pergola,
    }


# --- evaluation -------------------------------------------------------------------------


@dataclass(eq=False)
class FieldOutput(ModelOutput):
    """One scenario, one year, one day: `felt` and `exposure` are
    (hour, y, x) arrays (row 0 = the southern edge, see field_grid.Frame),
    the summaries (hour,) arrays."""

    date: date
    air_temperature: np.ndarray
    felt: np.ndarray
    exposure: np.ndarray
    mean_felt: np.ndarray
    heat_stress_pct: np.ndarray
    sunlit_pct: np.ndarray

    def __post_init__(self) -> None:
        super().__init__()


class FieldEvaluator(ModelEvaluator[FeltTemperatureField, FieldOutput]):
    def __init__(self, model: FeltTemperatureField) -> None:
        super().__init__(model)
        self._day: Day | None = None

    def run(self, rasters: FieldRasters, day: Day) -> FieldOutput:
        m = self._model
        values = field_inputs(rasters, day)
        overrides = {getattr(m.inputs, name): value for name, value in values.items()}
        self._day = day
        return self.evaluate(Scenario(m, overrides=overrides), EvaluationConfig(ensemble_size=1))

    def post_process(self, scenario: Scenario, result: EvaluationResult) -> FieldOutput:
        result_axes = result.layout.axes
        domain = {axis for axis in result_axes if axis in LAYOUT_AXES}
        if domain != set(LAYOUT_AXES):
            raise RuntimeError(f"evaluation layout {sorted(a.name for a in domain)} differs from LAYOUT_AXES")
        out = self._model.outputs

        def read(index: Index, axes: tuple) -> np.ndarray:
            return cdt_compat.own_axes(result[index], result_axes, axes)

        assert self._day is not None
        return FieldOutput(
            date=self._day.date,
            air_temperature=self._day.air_temperature,
            felt=read(out.felt, FIELD),
            exposure=read(out.exposure, FIELD),
            mean_felt=read(out.mean_felt, (HOUR,)),
            heat_stress_pct=read(out.heat_stress_pct, (HOUR,)),
            sunlit_pct=read(out.sunlit_pct, (HOUR,)),
        )

    def input_schema(self) -> dict[str, ParameterMeta]:
        return {}
