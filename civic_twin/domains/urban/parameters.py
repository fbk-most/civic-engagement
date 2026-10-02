"""Parameters of the urban model: species growth, tree lifecycle, prices
and indicator coefficients.

Heuristic lookup tables for a PoC, not a calibrated simulation or a
dendrological/actuarial model (see the project plan's stance on
indicators) — a domain expert should sanity-check them before any real
citizen-facing session. Each one is a parameter of the civic-digital-twins
model (see `build_model` in model.py), which a scenario can override.
"""

from typing import Literal

AgeClass = Literal["sapling", "young", "mature", "veteran"]

# ---------------------------------------------------------------------------
# Trees: species, growth, lifecycle
# ---------------------------------------------------------------------------

SPECIES_GROWTH = {
    "oak": {
        "maturity_years": 15, "mature_canopy_diameter": 10.0,
        "foliage_type": "deciduous", "crown_form": "round",
    },
    "birch": {
        "maturity_years": 10, "mature_canopy_diameter": 5.0,
        "foliage_type": "deciduous", "crown_form": "round",
    },
    "linden": {
        "maturity_years": 15, "mature_canopy_diameter": 8.0,
        "foliage_type": "deciduous", "crown_form": "round",
    },
    "plane": {
        "maturity_years": 18, "mature_canopy_diameter": 11.0,
        "foliage_type": "deciduous", "crown_form": "round",
    },
    "elm": {
        "maturity_years": 15, "mature_canopy_diameter": 9.0,
        "foliage_type": "deciduous", "crown_form": "round",
    },
    "ginkgo": {
        "maturity_years": 20, "mature_canopy_diameter": 6.0,
        "foliage_type": "deciduous", "crown_form": "round",
    },
    "horse_chestnut": {
        "maturity_years": 15, "mature_canopy_diameter": 9.0,
        "foliage_type": "deciduous", "crown_form": "round",
    },
    "cypress": {
        "maturity_years": 20, "mature_canopy_diameter": 3.5,
        "foliage_type": "evergreen", "crown_form": "columnar",
    },
    "pine": {
        "maturity_years": 20, "mature_canopy_diameter": 7.0,
        "foliage_type": "evergreen", "crown_form": "conical",
    },
    "unknown": {
        "maturity_years": 10, "mature_canopy_diameter": 6.0,
        "foliage_type": "deciduous", "crown_form": "round",
    },
}

# Plausible baseline species mix for a historic Trento plaza — a heuristic
# stand-in (like AGE_CLASS_WEIGHTS below), not real per-tree census data.
# Weighted toward the broadleaf shade trees a plaza of this kind is actually
# planted with, with cypress as a light ornamental accent and ginkgo/pine
# rarer — real OSM tags (where present) always override this draw, see
# ingestion/build_baseline.py.
TRENTO_SPECIES_WEIGHTS: dict[str, float] = {
    "plane": 0.28,
    "linden": 0.20,
    "horse_chestnut": 0.14,
    "oak": 0.12,
    "elm": 0.10,
    "birch": 0.08,
    "cypress": 0.05,
    "ginkgo": 0.02,
    "pine": 0.01,
}

HEIGHT_TO_CANOPY_RATIO = 1.3

# A mature conical/columnar evergreen (pine, cypress) is a tall spire, not a
# wide dome — applying the round-crown ratio above to them uniformly rendered
# every pine/cypress as a squat mushroom (a 7m-canopy pine came out only 9m
# tall). Keyed by crown_form since it's a shape property, not a per-species
# one; round crowns aren't listed here and fall back to HEIGHT_TO_CANOPY_RATIO
# via height_to_canopy_ratio() below.
HEIGHT_TO_CANOPY_RATIO_BY_FORM: dict[str, float] = {
    "conical": 2.4,
    "columnar": 4.0,
}

# Fraction of mature canopy diameter a baseline tree of each age class is
# assumed to already have reached, at t=0.
AGE_CLASS_DIAMETER_FRACTION: dict[AgeClass, float] = {
    "sapling": 0.2,
    "young": 0.5,
    "mature": 0.9,
    "veteran": 1.0,
}

# Sampling weights for assigning baseline trees an age class. Skewed toward
# mature/veteran (a historic plaza plausibly has a lot of established stock)
# and deliberately gives veteran a large enough share that cutting shows up
# within a 30-year horizon rather than being a rare edge case.
AGE_CLASS_WEIGHTS: dict[AgeClass, float] = {
    "sapling": 0.05,
    "young": 0.15,
    "mature": 0.45,
    "veteran": 0.35,
}

# Mean remaining years before a senescence-driven cut, by age class. Fed into
# a Weibull draw (shape 3, below) rather than a flat exponential, so risk
# rises with age instead of being front-loaded near year 0 — calibrated (by
# simulation, see PR discussion) so that ~90% of trees are never cut within
# the 30-year horizon overall, but close to half of veterans are, and cuts
# are spread across the horizon rather than clustered at either end.
AGE_CLASS_MEAN_REMAINING_LIFE_YEARS: dict[AgeClass, float] = {
    "sapling": 160,
    "young": 110,
    "mature": 70,
    "veteran": 32,
}

# Shape parameter for the senescence Weibull draw: >1 means hazard increases
# with age (an aging effect), unlike a flat exponential hazard.
SENESCENCE_WEIBULL_SHAPE = 3

# Independent flat hazard (storm/disease/etc.) applied regardless of age —
# modeled as a simple exponential (memoryless, constant per-year risk).
FLAT_HAZARD_MEAN_YEARS = 400

# Scenario horizon: a sampled cut beyond this many years is treated as
# "not expected to be cut in this scenario" (cut_year=None).
HORIZON_YEARS = 30

# Height of a cut tree's stump.
STUMP_HEIGHT = 0.3

# Canopy diameter of every tree of a grove at planting time.
GROVE_PLANTING_DIAMETER = 1.0

# ---------------------------------------------------------------------------
# Indicators
# ---------------------------------------------------------------------------

CO2_SEQUESTRATION_KG_PER_M2_CANOPY_PER_YEAR = 3.0

COOLING_C_PER_M2_CANOPY = -0.0010
WARMING_C_PER_M2_HARDSCAPE = 0.0001
REFERENCE_SUMMER_TEMPERATURE_C = 32.0
HARDSCAPE_COVER_TYPES = {"paving", "gravel"}

COST_PER_TREE_EUR = {"oak": 250, "birch": 150, "linden": 220, "unknown": 180}
COST_PER_PATH_M2_EUR = {"gravel": 40, "permeable_paving": 90, "wood": 120}
COST_PER_COVER_M2_EUR = {
    "lawn": 15,
    "meadow": 10,
    "wood": 35,
    "permeable_paving": 80,
    "paving": 60,
    "gravel": 25,
    "water": 150,
    "playground_surface": 120,
    "sport_surface": 70,
}

# Originally only covered the "nuovo percorso" card's own material options
# (paving/permeable_paving/wood/gravel) — real baseline paths carry raw OSM
# `surface` tags from a much wider vocabulary (sett, unhewn_cobblestone,
# fine_gravel, ...), which all silently fell through to the `.get(..., 50)`
# default and were never flagged fragile. Extended to the values actually
# seen on Piazza Dante's baseline plus other common OSM surface tags.
ACCESSIBILITY_SCORE_BY_MATERIAL = {
    "paving": 100,
    "paved": 100,
    "concrete": 95,
    "asphalt": 95,
    "paving_stones": 90,
    "permeable_paving": 90,
    "compacted": 65,
    "wood": 70,
    "fine_gravel": 45,
    "gravel": 40,
    "sett": 35,
    "cobblestone": 30,
    "ground": 30,
    "dirt": 25,
    "unhewn_cobblestone": 20,
    "grass": 20,
}
FRAGILE_PATH_MATERIALS = {
    "gravel", "fine_gravel", "sett", "cobblestone", "unhewn_cobblestone", "ground", "dirt", "grass",
}

# Social-indicator lookups: perceived safety and evening/winter usability are
# heuristic coverage scores (see model.py and geometry.py), not a
# calibrated lighting/thermal simulation — same "indicative, not simulated"
# stance as the rest of this file.
COST_PER_ELEMENT_EUR = {"streetlight": 900, "bench": 700, "kiosk": 15000}
COST_PER_PERGOLA_EUR = {"small": 4000, "medium": 7000, "large": 12000}

STREETLIGHT_ILLUMINATION_RADIUS_M = 12.0
SHELTER_RADIUS_M = {"pergola_small": 4.0, "pergola_medium": 6.0, "pergola_large": 9.0, "kiosk": 10.0}
