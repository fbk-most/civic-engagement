"""The urban model, as a civic-digital-twins model.

One evaluation computes one scenario — a baseline plus a set of
interventions, already turned into arrays by `encode.py` — for every year of
the horizon at once: the state of every tree (diameter, height, alive or
stump) and every indicator. Comparing scenarios (e.g. with the "as is" one,
which has no interventions) is up to the caller.

`UrbanModel` wires together one sub-model per concern: `TreeGrowth`,
`Carbon`, `Accessibility`, `Costs`, `Social`, `SpaceUse`.

Felt temperature, which varies across the site and through the day, is a
separate model (see thermal_field.py).

The model is built once; each scenario passes its own arrays, whose lengths
vary from one scenario to the next, as `Scenario` overrides. All the tables
and coefficients of `parameters.py` are model parameters (`Index` values a
scenario can override too).

Rounding is not done here: it is for display, and stays with the caller
(see `pack.py`).
"""

from dataclasses import dataclass
from typing import get_args

import numpy as np
from civic_digital_twins.dt_model import (
    ConstTimeseriesIndex,
    EvaluationResult,
    Functor,
    Index,
    Model,
    ModelEvaluator,
    ModelOutput,
    ParameterMeta,
    Scenario,
    TimeseriesIndex,
    define,
    expose,
    functions,
    graph,
    inputs,
    outputs,
)
from civic_digital_twins.dt_model.simulation.runner import EvaluationConfig

from bologna_civic_dt import cdt_compat, geometry
from bologna_civic_dt.parameters import (
    ACCESSIBILITY_SCORE_BY_MATERIAL,
    AGE_CLASS_DIAMETER_FRACTION,
    CO2_SEQUESTRATION_KG_PER_M2_CANOPY_PER_YEAR,
    COST_PER_COVER_M2_EUR,
    COST_PER_ELEMENT_EUR,
    COST_PER_PATH_M2_EUR,
    COST_PER_PERGOLA_EUR,
    COST_PER_TREE_EUR,
    FRAGILE_PATH_MATERIALS,
    HEIGHT_TO_CANOPY_RATIO,
    HEIGHT_TO_CANOPY_RATIO_BY_FORM,
    MAINTENANCE_PER_YEAR_EUR,
    HORIZON_YEARS,
    SHELTER_RADIUS_M,
    SPECIES_GROWTH,
    STREETLIGHT_ILLUMINATION_RADIUS_M,
    STUMP_HEIGHT,
)
from bologna_civic_dt.shapes import (
    AGE_CLASS,
    CARD,
    COST_ITEM,
    COVER,
    COVER_TYPE,
    COVER_WKB,
    COVER_WKB_OFFSET,
    INCLUSION_GROUP,
    LAMP,
    LAYOUT_AXES,
    MATERIAL,
    PATH,
    PRICE_KEY,
    SHELTER,
    SHELTER_KIND,
    SITE_WKB,
    SPECIES,
    TIME,
    TREE,
    CardIndex,
    CostItemIndex,
    CoverIndex,
    LampIndex,
    MaterialIndex,
    PathIndex,
    ShelterIndex,
    SpeciesIndex,
    TreeIndex,
    TreeTimeseriesIndex,
)
from bologna_civic_dt.types import CoverType

# --- categories: the order of every one-hot encoding and table ---------------

SPECIES_KEYS = list(SPECIES_GROWTH)
AGE_CLASSES = list(AGE_CLASS_DIAMETER_FRACTION)
# Materials outside the table score a flat 50 and are not fragile.
OTHER_MATERIAL = "other"
MATERIALS = [*ACCESSIBILITY_SCORE_BY_MATERIAL, OTHER_MATERIAL]
COVER_TYPES = list(get_args(CoverType))
SHELTER_KINDS = list(SHELTER_RADIUS_M)
INCLUSION_GROUPS = ["bambini", "giovani", "generale"]
INCLUSION_CARDS = {
    "add_playground": "bambini",
    "add_fitness_area": "giovani",
    "add_bench": "generale",
    "add_pergola": "generale",
    "add_kiosk": "generale",
    "add_streetlight": "generale",
    "add_streetlight_path": "generale",
}

# Prices, one key per (thing, kind); the `:other` keys are the fallbacks the
# cost indicator always used for kinds missing from a table.
PRICES: dict[str, float] = {
    **{f"tree:{k}": v for k, v in COST_PER_TREE_EUR.items()},
    **{f"path:{k}": v for k, v in COST_PER_PATH_M2_EUR.items()},
    "path:other": 50,
    **{f"cover:{k}": v for k, v in COST_PER_COVER_M2_EUR.items()},
    "cover:other": 30,
    **{f"element:{k}": v for k, v in COST_PER_ELEMENT_EUR.items()},
    **{f"pergola:{k}": v for k, v in COST_PER_PERGOLA_EUR.items()},
}
PRICE_KEYS = list(PRICES)
assert set(MAINTENANCE_PER_YEAR_EUR) == set(PRICES), "every priced item needs its upkeep, and vice versa"

# Axes of every per-scenario input — what `encode.py` must produce.
SCENARIO_INPUT_AXES: dict[str, tuple] = {
    "tree_species": (TREE, SPECIES),
    "tree_age_class": (TREE, AGE_CLASS),
    "tree_initial_diameter": (TREE,),
    "tree_planted": (TREE,),
    "tree_fixed_size": (TREE,),
    "tree_start": (TREE,),
    "tree_cut": (TREE,),
    "tree_end": (TREE,),
    "path_length": (PATH,),
    "path_material": (PATH, MATERIAL),
    "path_start": (PATH,),
    "cost_quantity": (COST_ITEM,),
    "cost_price_key": (COST_ITEM, PRICE_KEY),
    "cost_start": (COST_ITEM,),
    "cover_type": (COVER, COVER_TYPE),
    "cover_start": (COVER,),
    "cover_wkb": (COVER_WKB,),
    "cover_wkb_offsets": (COVER_WKB_OFFSET,),
    "lamp_x": (LAMP,),
    "lamp_y": (LAMP,),
    "lamp_start": (LAMP,),
    "shelter_x": (SHELTER,),
    "shelter_y": (SHELTER,),
    "shelter_kind": (SHELTER, SHELTER_KIND),
    "shelter_start": (SHELTER,),
    "card_group": (CARD, INCLUSION_GROUP),
    "card_start": (CARD,),
    "site_wkb": (SITE_WKB,),
    "site_area": (),
}


# --- helpers --------------------------------------------------------------------


def _lookup(onehot, table, axis):
    """Per-entity value of a table, from the entity's one-hot category.
    Exact: one term is the value times 1.0, every other one is 0.0."""
    return (onehot * table).sum(axis=axis)


def _clamp01(x):
    """max(0, min(1, x)), with the public graph helpers only."""
    return graph.where(x < 0.0, 0.0, graph.where(x > 1.0, 1.0, x))


def _canopy_area(diameter):
    return np.pi * (diameter / 2) ** 2


# --- sub-models ---------------------------------------------------------------------


@define("TreeGrowth")
class TreeGrowth(Model):
    """Per tree and year: canopy diameter, height, and whether it is alive
    or a stump. Planted trees grow from their planting year over their
    species' maturity years; young baseline trees from t=0 over what is left
    of it; mature and veteran baseline trees keep their size."""

    @inputs
    class Inputs:
        years: TimeseriesIndex
        species: Index  # (tree, species), one-hot
        age_class: Index  # (tree, age_class), one-hot; all zero for planted trees
        initial_diameter: TreeIndex
        planted: TreeIndex
        fixed_size: TreeIndex
        start: TreeIndex
        cut: TreeIndex
        end: TreeIndex
        maturity_years: SpeciesIndex
        mature_diameter: SpeciesIndex
        height_ratio: SpeciesIndex
        age_class_diameter_fraction: Index  # (age_class,)
        stump_height: Index

    @outputs
    class Outputs:
        diameter: TreeTimeseriesIndex
        height: TreeTimeseriesIndex
        status: TreeTimeseriesIndex  # 0 absent, 1 alive, 2 stump
        canopy_area: TreeTimeseriesIndex
        # Canopy area along the growth curve, ignoring when the tree is
        # planted and counting nothing from its cut on — what sequesters
        # CO2 — this year and the next.
        growing_area: TreeTimeseriesIndex
        growing_area_next: TreeTimeseriesIndex

    @expose
    class Expose:
        maturity: TreeIndex
        mature: TreeIndex
        ratio: TreeIndex
        growth_span: TreeIndex
        alive: TreeTimeseriesIndex
        stump: TreeTimeseriesIndex

    def compute(self, inputs: Inputs) -> tuple[Outputs, Expose]:
        i = inputs
        maturity = TreeIndex("maturity years", _lookup(i.species, i.maturity_years, SPECIES))
        mature = TreeIndex("mature diameter", _lookup(i.species, i.mature_diameter, SPECIES))
        ratio = TreeIndex("height ratio", _lookup(i.species, i.height_ratio, SPECIES))
        age_fraction = TreeIndex(
            "age class diameter fraction", _lookup(i.age_class, i.age_class_diameter_fraction, AGE_CLASS)
        )
        origin = TreeIndex("growth origin", graph.where(i.planted > 0.5, i.start, 0.0))
        span = TreeIndex("growth span", graph.where(i.fixed_size > 0.5, np.inf, maturity * (1 - age_fraction)))

        def grown(year):
            return i.initial_diameter + (mature - i.initial_diameter) * _clamp01((year - origin) / span)

        alive = TreeTimeseriesIndex("alive", (i.years >= i.start) & (i.years < i.cut))
        stump = TreeTimeseriesIndex("stump", (i.years >= i.cut) & (i.years < i.end))
        diameter = TreeTimeseriesIndex("canopy diameter", graph.where(alive, grown(i.years), 0.0))
        height = TreeTimeseriesIndex(
            "height", graph.where(alive, grown(i.years) * ratio, graph.where(stump, i.stump_height, 0.0))
        )
        status = TreeTimeseriesIndex("status", graph.where(alive, 1.0, graph.where(stump, 2.0, 0.0)))

        def growing(year):
            return _canopy_area(graph.where(year >= i.cut, 0.0, grown(year)))

        return (
            TreeGrowth.Outputs(
                diameter=diameter,
                height=height,
                status=status,
                canopy_area=TreeTimeseriesIndex("canopy area", _canopy_area(diameter)),
                growing_area=TreeTimeseriesIndex("growing canopy area", growing(i.years)),
                growing_area_next=TreeTimeseriesIndex("growing canopy area next year", growing(i.years + 1)),
            ),
            TreeGrowth.Expose(
                maturity=maturity, mature=mature, ratio=ratio, growth_span=span, alive=alive, stump=stump
            ),
        )


@define("Carbon")
class Carbon(Model):
    """CO2 sequestered by tree canopies: the yearly rate, and the total
    since t=0 as year-by-year trapezoids of each tree's canopy area from its
    planting year on."""

    @inputs
    class Inputs:
        years: TimeseriesIndex
        start: TreeIndex
        canopy_area: TreeTimeseriesIndex
        growing_area: TreeTimeseriesIndex
        growing_area_next: TreeTimeseriesIndex
        co2_per_m2_canopy: Index

    @outputs
    class Outputs:
        annual: TimeseriesIndex
        cumulative: TimeseriesIndex

    @expose
    class Expose:
        increment: TreeTimeseriesIndex
        yearly: TimeseriesIndex

    def compute(self, inputs: Inputs) -> tuple[Outputs, Expose]:
        i = inputs
        annual = TimeseriesIndex("co2 annual", (i.canopy_area * i.co2_per_m2_canopy).sum(axis=TREE))
        increment = TreeTimeseriesIndex(
            "co2 increment",
            graph.where(
                i.years >= i.start, 0.5 * (i.growing_area + i.growing_area_next) * i.co2_per_m2_canopy, 0.0
            ),
        )
        yearly = TimeseriesIndex("co2 yearly", increment.sum(axis=TREE))
        # Up to (not including) each year: the running sum, one year late.
        running = TimeseriesIndex("co2 running sum", yearly.cumulative(axis=TIME))
        cumulative = TimeseriesIndex("co2 cumulative", running.shift(1, axis=TIME))
        return Carbon.Outputs(annual=annual, cumulative=cumulative), Carbon.Expose(increment=increment, yearly=yearly)


@define("Accessibility")
class Accessibility(Model):
    """Walkability (path score weighted by length) and the share of path
    length on fragile surfaces; NaN while there are no paths."""

    @inputs
    class Inputs:
        years: TimeseriesIndex
        length: PathIndex
        material: Index  # (path, material), one-hot
        start: PathIndex
        material_score: MaterialIndex
        material_fragile: MaterialIndex

    @outputs
    class Outputs:
        walkability: TimeseriesIndex
        fragile_pct: TimeseriesIndex

    @expose
    class Expose:
        total_length: TimeseriesIndex
        fragile_length: TimeseriesIndex

    def compute(self, inputs: Inputs) -> tuple[Outputs, Expose]:
        i = inputs
        active = i.years >= i.start
        score = PathIndex("path score", _lookup(i.material, i.material_score, MATERIAL))
        fragile = PathIndex("path fragile", _lookup(i.material, i.material_fragile, MATERIAL))
        total = TimeseriesIndex("total path length", graph.where(active, i.length, 0.0).sum(axis=PATH))
        weighted = TimeseriesIndex("score-weighted length", graph.where(active, i.length * score, 0.0).sum(axis=PATH))
        fragile_length = TimeseriesIndex(
            "fragile path length", graph.where(active & (fragile > 0.5), i.length, 0.0).sum(axis=PATH)
        )
        has_paths = total > 0
        divisor = graph.where(has_paths, total, 1.0)
        return (
            Accessibility.Outputs(
                walkability=TimeseriesIndex("walkability", graph.where(has_paths, weighted / divisor, np.nan)),
                fragile_pct=TimeseriesIndex(
                    "fragile path pct", graph.where(has_paths, 100 * fragile_length / divisor, np.nan)
                ),
            ),
            Accessibility.Expose(total_length=total, fragile_length=fragile_length),
        )


@define("Costs")
class Costs(Model):
    """Cost of the interventions in place: quantity times unit price, from
    each item's start year on; and the upkeep they add, every year from
    then on — that year's, and the total paid before it (like the CO₂
    absorbed: at t=10, ten years of upkeep)."""

    @inputs
    class Inputs:
        years: TimeseriesIndex
        quantity: CostItemIndex
        price_key: Index  # (cost_item, price_key), one-hot
        start: CostItemIndex
        price: Index  # (price_key,)
        maintenance_price: Index  # (price_key,)

    @outputs
    class Outputs:
        cost: TimeseriesIndex
        maintenance: TimeseriesIndex
        maintenance_cumulative: TimeseriesIndex

    def compute(self, inputs: Inputs) -> Outputs:
        i = inputs
        in_place = i.years >= i.start
        unit_price = CostItemIndex("unit price", _lookup(i.price_key, i.price, PRICE_KEY))
        cost = graph.where(in_place, i.quantity * unit_price, 0.0).sum(axis=COST_ITEM)
        unit_upkeep = CostItemIndex("unit upkeep", _lookup(i.price_key, i.maintenance_price, PRICE_KEY))
        maintenance = TimeseriesIndex(
            "maintenance", graph.where(in_place, i.quantity * unit_upkeep, 0.0).sum(axis=COST_ITEM)
        )
        running = TimeseriesIndex("maintenance running sum", maintenance.cumulative(axis=TIME))
        return Costs.Outputs(
            cost=TimeseriesIndex("cost", cost),
            maintenance=maintenance,
            maintenance_cumulative=TimeseriesIndex("maintenance cumulative", running.shift(1, axis=TIME)),
        )


@define("Social")
class Social(Model):
    """Safety (% of the site lit by a streetlight), evening/winter usability
    (the mean of safety and shelter, the % of the site within reach of the
    best-placed shelter) and which age groups the interventions cater for."""

    @inputs
    class Inputs:
        years: TimeseriesIndex
        lamp_x: LampIndex
        lamp_y: LampIndex
        lamp_start: LampIndex
        shelter_x: ShelterIndex
        shelter_y: ShelterIndex
        shelter_kind: Index  # (shelter, shelter_kind), one-hot
        shelter_start: ShelterIndex
        card_group: Index  # (card, inclusion_group), one-hot
        card_start: CardIndex
        site_wkb: Index  # (site_wkb,)
        streetlight_radius: Index
        shelter_radius: Index  # (shelter_kind,)

    @outputs
    class Outputs:
        safety: TimeseriesIndex
        evening_winter: TimeseriesIndex
        inclusion: Index  # (inclusion_group, time)

    @expose
    class Expose:
        shelter: TimeseriesIndex
        shelter_reach: ShelterIndex

    @functions
    class Functions:
        lit_share: Functor
        shelter_reach: Functor

    def compute(self, inputs: Inputs, *, fns: Functions) -> tuple[Outputs, Expose]:
        i = inputs
        safety = TimeseriesIndex(
            "safety",
            graph.function_call(
                "lit_share", i.years, i.lamp_x, i.lamp_y, i.lamp_start, i.streetlight_radius, i.site_wkb,
                functor=fns.lit_share,
            ),
        )
        radius = ShelterIndex("shelter radius per shelter", _lookup(i.shelter_kind, i.shelter_radius, SHELTER_KIND))
        reach = ShelterIndex(
            "shelter reach",
            graph.function_call(
                "shelter_reach", i.shelter_x, i.shelter_y, radius, i.site_wkb, functor=fns.shelter_reach
            ),
        )
        shelter = TimeseriesIndex("shelter", graph.where(i.years >= i.shelter_start, reach, 0.0).max(axis=SHELTER))
        inclusion = Index(
            "inclusion",
            graph.where(i.years >= i.card_start, i.card_group, 0.0).max(axis=CARD),
            axes=(INCLUSION_GROUP, TIME),
        )
        evening_winter = TimeseriesIndex("evening winter", (safety + shelter) / 2)
        return (
            Social.Outputs(safety=safety, evening_winter=evening_winter, inclusion=inclusion),
            Social.Expose(shelter=shelter, shelter_reach=reach),
        )


@define("SpaceUse")
class SpaceUse(Model):
    """% of the site per cover type, later covers taking precedence where
    they overlap; NaN where a type occupies nothing."""

    @inputs
    class Inputs:
        years: TimeseriesIndex
        cover_wkb: Index  # (cover_wkb,)
        cover_wkb_offsets: Index  # (cover_wkb_offset,)
        cover_type: Index  # (cover, cover_type), one-hot
        cover_start: CoverIndex
        site_wkb: Index  # (site_wkb,)
        site_area: Index

    @outputs
    class Outputs:
        pct: Index  # (cover_type, time)

    @functions
    class Functions:
        cover_areas: Functor

    def compute(self, inputs: Inputs, *, fns: Functions) -> Outputs:
        i = inputs
        areas = Index(
            "cover type areas",
            graph.function_call(
                "cover_areas", i.years, i.cover_wkb, i.cover_wkb_offsets, i.cover_start, i.cover_type, i.site_wkb,
                functor=fns.cover_areas,
            ),
            axes=(COVER_TYPE, TIME),
        )
        return SpaceUse.Outputs(pct=Index("space use pct", 100 * areas / i.site_area, axes=(COVER_TYPE, TIME)))


# --- the whole model -------------------------------------------------------------------


@define("UrbanModel")
class UrbanModel(Model):
    @inputs
    class Inputs:
        # per scenario (see SCENARIO_INPUT_AXES)
        tree_species: Index  # (tree, species), one-hot
        tree_age_class: Index  # (tree, age_class), one-hot
        tree_initial_diameter: TreeIndex
        tree_planted: TreeIndex
        tree_fixed_size: TreeIndex
        tree_start: TreeIndex
        tree_cut: TreeIndex
        tree_end: TreeIndex
        path_length: PathIndex
        path_material: Index  # (path, material), one-hot
        path_start: PathIndex
        cost_quantity: CostItemIndex
        cost_price_key: Index  # (cost_item, price_key), one-hot
        cost_start: CostItemIndex
        cover_type: Index  # (cover, cover_type), one-hot
        cover_start: CoverIndex
        cover_wkb: Index  # (cover_wkb,)
        cover_wkb_offsets: Index  # (cover_wkb_offset,)
        lamp_x: LampIndex
        lamp_y: LampIndex
        lamp_start: LampIndex
        shelter_x: ShelterIndex
        shelter_y: ShelterIndex
        shelter_kind: Index  # (shelter, shelter_kind), one-hot
        shelter_start: ShelterIndex
        card_group: Index  # (card, inclusion_group), one-hot
        card_start: CardIndex
        site_wkb: Index  # (site_wkb,)
        site_area: Index
        # parameters (see parameters.py)
        maturity_years: SpeciesIndex
        mature_diameter: SpeciesIndex
        height_ratio: SpeciesIndex
        age_class_diameter_fraction: Index  # (age_class,)
        stump_height: Index
        co2_per_m2_canopy: Index
        material_score: MaterialIndex
        material_fragile: MaterialIndex
        price: Index  # (price_key,)
        maintenance_price: Index  # (price_key,)
        streetlight_radius: Index
        shelter_radius: Index  # (shelter_kind,)

    @outputs
    class Outputs:
        tree_diameter: TreeTimeseriesIndex
        tree_height: TreeTimeseriesIndex
        tree_status: TreeTimeseriesIndex  # 0 absent, 1 alive, 2 stump
        co2_annual: TimeseriesIndex
        co2_cumulative: TimeseriesIndex
        walkability: TimeseriesIndex
        fragile_path_pct: TimeseriesIndex
        cost: TimeseriesIndex
        maintenance: TimeseriesIndex
        maintenance_cumulative: TimeseriesIndex
        safety: TimeseriesIndex
        evening_winter: TimeseriesIndex
        inclusion: Index  # (inclusion_group, time)
        space_use_pct: Index  # (cover_type, time)

    @expose
    class Expose:
        tree_canopy_area: TreeTimeseriesIndex
        co2_yearly: TimeseriesIndex
        total_path_length: TimeseriesIndex
        shelter: TimeseriesIndex
        shelter_reach: ShelterIndex

    @functions
    class Functions:
        lit_share: Functor
        shelter_reach: Functor
        cover_areas: Functor

    def compute(self, inputs: Inputs, *, fns: Functions) -> tuple[Outputs, Expose]:
        i = inputs
        years = ConstTimeseriesIndex("years", np.arange(HORIZON_YEARS + 1, dtype=float))

        trees = TreeGrowth(inputs=TreeGrowth.Inputs(
            years=years, species=i.tree_species, age_class=i.tree_age_class,
            initial_diameter=i.tree_initial_diameter, planted=i.tree_planted, fixed_size=i.tree_fixed_size,
            start=i.tree_start, cut=i.tree_cut, end=i.tree_end,
            maturity_years=i.maturity_years, mature_diameter=i.mature_diameter, height_ratio=i.height_ratio,
            age_class_diameter_fraction=i.age_class_diameter_fraction, stump_height=i.stump_height,
        ))
        carbon = Carbon(inputs=Carbon.Inputs(
            years=years, start=i.tree_start, canopy_area=trees.outputs.canopy_area,
            growing_area=trees.outputs.growing_area, growing_area_next=trees.outputs.growing_area_next,
            co2_per_m2_canopy=i.co2_per_m2_canopy,
        ))
        accessibility = Accessibility(inputs=Accessibility.Inputs(
            years=years, length=i.path_length, material=i.path_material, start=i.path_start,
            material_score=i.material_score, material_fragile=i.material_fragile,
        ))
        costs = Costs(inputs=Costs.Inputs(
            years=years, quantity=i.cost_quantity, price_key=i.cost_price_key, start=i.cost_start, price=i.price,
            maintenance_price=i.maintenance_price,
        ))
        social = Social(
            inputs=Social.Inputs(
                years=years, lamp_x=i.lamp_x, lamp_y=i.lamp_y, lamp_start=i.lamp_start,
                shelter_x=i.shelter_x, shelter_y=i.shelter_y, shelter_kind=i.shelter_kind,
                shelter_start=i.shelter_start, card_group=i.card_group, card_start=i.card_start,
                site_wkb=i.site_wkb, streetlight_radius=i.streetlight_radius, shelter_radius=i.shelter_radius,
            ),
            fns=Social.Functions(lit_share=fns.lit_share, shelter_reach=fns.shelter_reach),
        )
        space_use = SpaceUse(
            inputs=SpaceUse.Inputs(
                years=years, cover_wkb=i.cover_wkb, cover_wkb_offsets=i.cover_wkb_offsets, cover_type=i.cover_type,
                cover_start=i.cover_start, site_wkb=i.site_wkb, site_area=i.site_area,
            ),
            fns=SpaceUse.Functions(cover_areas=fns.cover_areas),
        )

        return (
            UrbanModel.Outputs(
                tree_diameter=trees.outputs.diameter,
                tree_height=trees.outputs.height,
                tree_status=trees.outputs.status,
                co2_annual=carbon.outputs.annual,
                co2_cumulative=carbon.outputs.cumulative,
                walkability=accessibility.outputs.walkability,
                fragile_path_pct=accessibility.outputs.fragile_pct,
                cost=costs.outputs.cost,
                maintenance=costs.outputs.maintenance,
                maintenance_cumulative=costs.outputs.maintenance_cumulative,
                safety=social.outputs.safety,
                evening_winter=social.outputs.evening_winter,
                inclusion=social.outputs.inclusion,
                space_use_pct=space_use.outputs.pct,
            ),
            UrbanModel.Expose(
                tree_canopy_area=trees.outputs.canopy_area,
                co2_yearly=carbon.expose.yearly,
                total_path_length=accessibility.expose.total_length,
                shelter=social.expose.shelter,
                shelter_reach=social.expose.shelter_reach,
            ),
        )


def _height_ratio(species: str) -> float:
    form = SPECIES_GROWTH[species]["crown_form"]
    return HEIGHT_TO_CANOPY_RATIO_BY_FORM.get(form, HEIGHT_TO_CANOPY_RATIO)


def _table(index_class, name: str, values: list[float], axes: tuple | None = None) -> Index:
    array = np.asarray(values, dtype=float)
    return index_class(name, array) if axes is None else index_class(name, array, axes=axes)


def build_model() -> UrbanModel:
    """The model, with every per-scenario input left open and every
    parameter at its `parameters.py` value."""

    def open_input(name: str) -> Index:
        axes = SCENARIO_INPUT_AXES[name]
        return Index(name, None, axes=axes) if axes else Index(name, None)

    scenario_inputs = {name: open_input(name) for name in SCENARIO_INPUT_AXES}
    parameters = {
        "maturity_years": _table(
            SpeciesIndex, "maturity years", [SPECIES_GROWTH[s]["maturity_years"] for s in SPECIES_KEYS]
        ),
        "mature_diameter": _table(
            SpeciesIndex, "mature canopy diameter", [SPECIES_GROWTH[s]["mature_canopy_diameter"] for s in SPECIES_KEYS]
        ),
        "height_ratio": _table(SpeciesIndex, "height to canopy ratio", [_height_ratio(s) for s in SPECIES_KEYS]),
        "age_class_diameter_fraction": _table(
            Index, "age class diameter fraction", [AGE_CLASS_DIAMETER_FRACTION[a] for a in AGE_CLASSES], (AGE_CLASS,)
        ),
        "stump_height": Index("stump height", STUMP_HEIGHT),
        "co2_per_m2_canopy": Index("co2 per m2 canopy", CO2_SEQUESTRATION_KG_PER_M2_CANOPY_PER_YEAR),
        "material_score": _table(
            MaterialIndex, "material score", [ACCESSIBILITY_SCORE_BY_MATERIAL.get(m, 50) for m in MATERIALS]
        ),
        "material_fragile": _table(MaterialIndex, "fragile", [float(m in FRAGILE_PATH_MATERIALS) for m in MATERIALS]),
        "price": _table(Index, "unit price", [PRICES[k] for k in PRICE_KEYS], (PRICE_KEY,)),
        "maintenance_price": _table(
            Index, "unit upkeep per year", [MAINTENANCE_PER_YEAR_EUR[k] for k in PRICE_KEYS], (PRICE_KEY,)
        ),
        "streetlight_radius": Index("streetlight radius", STREETLIGHT_ILLUMINATION_RADIUS_M),
        "shelter_radius": _table(
            Index, "shelter radius", [SHELTER_RADIUS_M[k] for k in SHELTER_KINDS], (SHELTER_KIND,)
        ),
    }
    functors = UrbanModel.Functions(
        lit_share=cdt_compat.on_axes(
            geometry.lit_share, [(TIME,), (LAMP,), (LAMP,), (LAMP,), (), (SITE_WKB,)], (TIME,), LAYOUT_AXES
        ),
        shelter_reach=cdt_compat.on_axes(
            geometry.shelter_reach, [(SHELTER,), (SHELTER,), (SHELTER,), (SITE_WKB,)], (SHELTER,), LAYOUT_AXES
        ),
        cover_areas=cdt_compat.on_axes(
            geometry.cover_areas,
            [(TIME,), (COVER_WKB,), (COVER_WKB_OFFSET,), (COVER,), (COVER, COVER_TYPE), (SITE_WKB,)],
            (COVER_TYPE, TIME),
            LAYOUT_AXES,
        ),
    )
    return UrbanModel(inputs=UrbanModel.Inputs(**scenario_inputs, **parameters), fns=functors)


# --- evaluation --------------------------------------------------------------------


@dataclass(eq=False)
class UrbanOutput(ModelOutput):
    """One scenario, every year: `tree_*` are (tree, time) arrays over the
    real trees only (no sentinel); indicators are (time,) arrays, except
    `inclusion` (group, time) and `space_use_pct` (cover type, time; NaN
    where a cover type occupies nothing)."""

    tree_diameter: np.ndarray
    tree_height: np.ndarray
    tree_status: np.ndarray
    indicators: dict[str, np.ndarray]

    def __post_init__(self) -> None:
        super().__init__()


OUTPUT_AXES = {
    "inclusion": (INCLUSION_GROUP, TIME),
    "space_use_pct": (COVER_TYPE, TIME),
}


class UrbanEvaluator(ModelEvaluator[UrbanModel, UrbanOutput]):
    def __init__(self, model: UrbanModel) -> None:
        super().__init__(model)
        self._n_trees = 0

    def run(self, scenario_inputs: dict[str, np.ndarray]) -> UrbanOutput:
        """Evaluate one scenario, given every input of SCENARIO_INPUT_AXES."""
        m = self._model
        overrides = {getattr(m.inputs, name): value for name, value in scenario_inputs.items()}
        self._n_trees = cdt_compat.n_real(scenario_inputs["tree_start"])
        return self.evaluate(Scenario(m, overrides=overrides), EvaluationConfig(ensemble_size=1))

    def post_process(self, scenario: Scenario, result: EvaluationResult) -> UrbanOutput:
        result_axes = result.layout.axes
        domain = {axis for axis in result_axes if axis in LAYOUT_AXES}
        if domain != set(LAYOUT_AXES):
            raise RuntimeError(f"evaluation layout {sorted(a.name for a in domain)} differs from LAYOUT_AXES")
        out = self._model.outputs

        def read(index: Index, axes: tuple) -> np.ndarray:
            return cdt_compat.own_axes(result[index], result_axes, axes)

        def trees(index: Index) -> np.ndarray:
            return read(index, (TREE, TIME))[: self._n_trees]

        names = [
            "co2_annual", "co2_cumulative", "walkability",
            "fragile_path_pct", "cost", "maintenance", "maintenance_cumulative",
            "safety", "evening_winter", "inclusion", "space_use_pct",
        ]
        return UrbanOutput(
            tree_diameter=trees(out.tree_diameter),
            tree_height=trees(out.tree_height),
            tree_status=trees(out.tree_status),
            indicators={name: read(getattr(out, name), OUTPUT_AXES.get(name, (TIME,))) for name in names},
        )

    def input_schema(self) -> dict[str, ParameterMeta]:
        return {}
