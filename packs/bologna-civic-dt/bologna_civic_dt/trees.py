"""Baseline trees' identity, and the per-species traits every tree carries.

Baseline (OSM-derived) trees have no known planting date or species census,
so each is assigned once, offline, at baseline-ingestion time (see
`ingestion/build_baseline.py`): a species when OSM has no usable tag, then an
`age_class`, a current canopy diameter and a `cut_year` — a one-time,
deterministic (seeded per tree id) draw from a simple two-component hazard
model, so the 30-year scenario has a plausible, reproducible spread of tree
removals instead of either "nothing is ever cut" or "everything is cut at
once". How trees then grow over the years is the urban model's (see
`model.py`).

Lookup-table heuristics for a PoC, not a dendrological or actuarial model —
see the project plan's stance on indicators.
"""

import math
import random

from bologna_civic_dt.parameters import (
    AGE_CLASS_DIAMETER_FRACTION,
    AGE_CLASS_MEAN_REMAINING_LIFE_YEARS,
    AGE_CLASS_WEIGHTS,
    FLAT_HAZARD_MEAN_YEARS,
    HEIGHT_TO_CANOPY_RATIO,
    HEIGHT_TO_CANOPY_RATIO_BY_FORM,
    HORIZON_YEARS,
    SENESCENCE_WEIBULL_SHAPE,
    SPECIES_GROWTH,
    TRENTO_SPECIES_WEIGHTS,
    AgeClass,
)


def species_traits(species: str) -> dict:
    """foliage_type/crown_form for a species, falling back to the generic
    'unknown' entry — the single lookup used everywhere a tree
    `DiscreteElement` is built (ingestion, `pack.py`), so baseline and
    citizen-placed trees always carry these two fields the same way."""
    growth = SPECIES_GROWTH.get(species, SPECIES_GROWTH["unknown"])
    return {"foliage_type": growth["foliage_type"], "crown_form": growth["crown_form"]}


def assign_baseline_species(tree_id: str) -> str:
    """One-time, deterministic (seeded by tree id) species draw for a baseline
    tree with no usable OSM tag — same seeding pattern as
    `assign_baseline_tree_identity` below, so re-running ingestion reproduces
    the same assignment."""
    rng = random.Random(f"trento-tree-species-{tree_id}")
    species = list(TRENTO_SPECIES_WEIGHTS.keys())
    return rng.choices(species, weights=[TRENTO_SPECIES_WEIGHTS[s] for s in species], k=1)[0]


def height_to_canopy_ratio(species: str) -> float:
    """height = canopy_diameter * this, see HEIGHT_TO_CANOPY_RATIO(_BY_FORM)
    in parameters.py."""
    growth = SPECIES_GROWTH.get(species, SPECIES_GROWTH["unknown"])
    return HEIGHT_TO_CANOPY_RATIO_BY_FORM.get(growth["crown_form"], HEIGHT_TO_CANOPY_RATIO)


def _weighted_choice(rng: random.Random, weights: dict[AgeClass, float]) -> AgeClass:
    classes = list(weights.keys())
    return rng.choices(classes, weights=[weights[c] for c in classes], k=1)[0]


def assign_baseline_tree_identity(tree_id: str, species: str) -> dict:
    """One-time, deterministic (seeded by tree id) assignment of age_class,
    current canopy_diameter and cut_year for a baseline tree — run once at
    ingestion time and baked into the baseline JSON, never recomputed live.
    """
    rng = random.Random(f"trento-tree-{tree_id}")

    age_class = _weighted_choice(rng, AGE_CLASS_WEIGHTS)

    growth = SPECIES_GROWTH.get(species, SPECIES_GROWTH["unknown"])
    canopy_diameter = round(growth["mature_canopy_diameter"] * AGE_CLASS_DIAMETER_FRACTION[age_class], 2)

    # Weibull mean = scale * Gamma(1 + 1/shape); solve for scale given the
    # desired mean so AGE_CLASS_MEAN_REMAINING_LIFE_YEARS stays interpretable.
    mean = AGE_CLASS_MEAN_REMAINING_LIFE_YEARS[age_class]
    scale = mean / math.gamma(1 + 1 / SENESCENCE_WEIBULL_SHAPE)
    senescence_year = rng.weibullvariate(scale, SENESCENCE_WEIBULL_SHAPE)
    hazard_year = rng.expovariate(1 / FLAT_HAZARD_MEAN_YEARS)
    cut_year_raw = round(min(senescence_year, hazard_year))
    cut_year = cut_year_raw if cut_year_raw <= HORIZON_YEARS else None

    return {
        "age_class": age_class,
        "canopy_diameter": canopy_diameter,
        "cut_year": cut_year,
    }
