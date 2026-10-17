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

# What each intervention adds to the yearly upkeep, per unit of what its
# build cost counts (a tree, a m² of path or cover, a lamp, a pergola) —
# rough municipal figures, same "indicative" stance as the prices above:
# a young street tree's watering and pruning; a lawn's mowing; an LED
# streetlight's energy (~200 kWh a year) and servicing; a playground's
# inspections and surface. The keys mirror the prices', `:other` included.
MAINTENANCE_PER_YEAR_EUR = {
    **{f"tree:{k}": v for k, v in {"oak": 60, "birch": 50, "linden": 60, "unknown": 50}.items()},
    **{f"path:{k}": v for k, v in {"gravel": 3.0, "permeable_paving": 1.5, "wood": 6.0}.items()},
    "path:other": 2.0,
    **{
        f"cover:{k}": v
        for k, v in {
            "lawn": 2.0,
            "meadow": 0.5,
            "wood": 4.0,
            "permeable_paving": 1.5,
            "paving": 1.0,
            "gravel": 1.5,
            "water": 15.0,
            "playground_surface": 8.0,
            "sport_surface": 5.0,
        }.items()
    },
    "cover:other": 1.0,
    "element:streetlight": 80,
    "element:bench": 40,
    "element:kiosk": 500,
    "pergola:small": 150,
    "pergola:medium": 250,
    "pergola:large": 400,
}

STREETLIGHT_ILLUMINATION_RADIUS_M = 12.0
SHELTER_RADIUS_M = {"pergola_small": 4.0, "pergola_medium": 6.0, "pergola_large": 9.0, "kiosk": 10.0}

# ---------------------------------------------------------------------------
# Felt temperature (thermal_field.py, solar.py)
# ---------------------------------------------------------------------------
#
# A cheap proxy for felt temperature (in the spirit of UTCI) at 1.1 m above
# the ground, per 1 m cell and hour of a typical fair day: the air
# temperature, plus the sun on a person, plus the heat the ground has
# stored, plus what vegetation and water take away. No wind, no walls
# re-radiating at night. Placeholder values to be checked by a domain
# expert, like the rest of this file.

SITE_TIMEZONE = "Europe/Rome"

# Typical daily (min, max) air temperature by month, °C — rough values for
# Trento (valley floor, Trento Laste station) to be replaced by the
# station's normals; read on the 15th, interpolated in between.
TYPICAL_DAILY_TEMPERATURE_C: dict[int, tuple[float, float]] = {
    1: (-1.5, 6.5),
    2: (-0.5, 9.5),
    3: (3.0, 15.0),
    4: (7.0, 19.0),
    5: (11.5, 23.5),
    6: (15.0, 28.0),
    7: (17.0, 30.5),
    8: (16.5, 29.5),
    9: (12.5, 24.5),
    10: (8.0, 18.0),
    11: (3.0, 11.0),
    12: (-1.0, 6.0),
}
# Local hour of the day's warmest air (the coolest is at sunrise).
WARMEST_HOUR = 15

# Climate assumption: how much warmer the air gets, the year round, `t`
# years from now. A shift of the whole day (min and max alike) by month,
# reached in CLIMATE_RAMP_YEARS and growing by CLIMATE_TREND_C_PER_YEAR
# after that.
#
# The summer stands for "a summer like 2022 becomes the usual one in ten
# years": at Trento Laste, summer 2022 averaged 24.8 °C, the second warmest
# in a century after 2003 (24.9), against a long-term mean of 22.1, and had
# the most days above 30 °C on record (65; Meteotrentino, "Analisi
# stagionale estate 2022"). The typical summer above averages about 22.8,
# so +2 °C. The other months get the long-term trend only (about +0.5 °C a
# decade); May and September are in between. A deliberately warm, but not
# extreme, assumption — chosen for the demo storyline, to be checked with a
# climatologist.
CLIMATE_WARMING_C: dict[int, float] = {
    1: 0.5, 2: 0.5, 3: 0.5, 4: 0.5, 5: 1.0, 6: 2.0,
    7: 2.0, 8: 2.0, 9: 1.0, 10: 0.5, 11: 0.5, 12: 0.5,
}
CLIMATE_RAMP_YEARS = 10
CLIMATE_TREND_C_PER_YEAR = 0.05

# Deciduous leaf cover by month (month, 0-1) — the 3D view's
# LEAF_DENSITY_POINTS (frontend/src/three/sun.ts); keep the two equal.
LEAF_DENSITY_BY_MONTH: list[tuple[int, float]] = [
    (1, 0.0), (3, 0.0), (4, 0.5), (5, 1.0), (9, 1.0), (10, 0.55), (11, 0.1), (12, 0.0),
]

FIELD_CELL_M = 1.0
# Where felt temperature is taken: about chest height.
PERSON_HEIGHT_M = 1.1

# Felt temperature added by direct sun on a person, °C per kW/m² of beam
# (sun vs shade on a clear summer afternoon: about +10 °C).
SUN_GAIN_C_PER_KW = 11.0

# Light passing through tree crowns, as extinction per metre of crown
# crossed: a 6 m crown in full leaf lets ~12% through, bare ~60%.
CROWN_EXTINCTION_LEAFY_PER_M = 0.35
CROWN_EXTINCTION_BARE_PER_M = 0.08
# A pergola's lattice roof: a thin slab letting through about half the sun.
PERGOLA_EXTINCTION_PER_M = 3.0
PERGOLA_SLAB_M = 0.25
# The 3D view's crown base, as a fraction of tree height
# (frontend/src/three/builders/vegetation.ts).
CROWN_BASE_FRACTION = 0.3
CROWN_BASE_FRACTION_EVERGREEN = 0.08

# Ground surfaces, by how they behave in the sun. Paths and streets map
# their OSM `surface` (MATERIAL_SURFACE), covers their type
# (COVER_SURFACE); ground nothing describes is DEFAULT_SURFACE.
SURFACES = ["asphalt", "stone", "concrete", "gravel", "permeable", "wood", "rubber", "lawn", "meadow", "water"]
DEFAULT_SURFACE = "stone"
MATERIAL_SURFACE = {
    "asphalt": "asphalt",
    "concrete": "concrete",
    "gravel": "gravel",
    "fine_gravel": "gravel",
    "compacted": "gravel",
    "ground": "meadow",
    "dirt": "meadow",
    "grass": "lawn",
    "wood": "wood",
    "permeable_paving": "permeable",
}  # everything else (sett, paving_stones, paving, ...) is stone
COVER_SURFACE = {
    "paving": "stone",
    "lawn": "lawn",
    "meadow": "meadow",
    "wood": "meadow",
    "water": "water",
    "gravel": "gravel",
    "permeable_paving": "permeable",
    "playground_surface": "rubber",
    "sport_surface": "rubber",
}
# Felt temperature the ground adds once fully heated, °C: how much sun it
# stores and gives back (night included). "Fully heated" is a few hours of
# high summer sun; the store fades by GROUND_HEAT_RETENTION each hour.
GROUND_HEAT_C: dict[str, float] = {
    "asphalt": 4.0, "stone": 3.0, "concrete": 3.0, "gravel": 2.0, "permeable": 2.0,
    "wood": 1.5, "rubber": 3.5, "lawn": 0.5, "meadow": 0.5, "water": 0.0,
}
GROUND_HEAT_RETENTION = 0.75
# Constant cooling of evaporating surfaces, °C.
SURFACE_COOLING_C: dict[str, float] = {"lawn": -0.5, "meadow": -0.7}
# Under a crown in full leaf, beyond its shade (evapotranspiration), °C.
CANOPY_COOLING_C = -1.0
# Water cools the air around it on warm days: a pond (any water cover) by
# WATER_COOLING_C on it and at its edge, fading with distance (halving
# every WATER_HALF_DISTANCE_M); a fountain likewise, over a few metres.
# Both scale with the air temperature, from nothing at
# WATER_COOLING_FROM_C to full at WATER_COOLING_FULL_C.
WATER_COOLING_C = -2.5
WATER_HALF_DISTANCE_M = 10.0
FOUNTAIN_COOLING_C = -2.0
FOUNTAIN_HALF_DISTANCE_M = 3.0
WATER_COOLING_FROM_C = 10.0
WATER_COOLING_FULL_C = 25.0

# Felt temperature from which the summary counts "strong heat stress"
# (UTCI's threshold).
HEAT_STRESS_C = 32.0
# The moment the thermal indicators describe, whatever the sun control
# shows: a midsummer late morning (month, day, hour). Not the afternoon:
# then the open space is in heat stress today as in the future, with or
# without shade, and the indicators can't tell scenarios apart. At 11:00 the
# square is still pleasant today and the climate assumption
# (CLIMATE_WARMING_C) takes it past strong heat stress — the demo storyline.
THERMAL_REFERENCE = (6, 21, 11)
