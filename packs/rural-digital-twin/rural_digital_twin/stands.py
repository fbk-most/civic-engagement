"""Forest stands: areas of forest with their attributes, carried as covers
of type "forest" with properties (see the core's CoverPolygon). The browser
grows the trees from them; the model works on them, not on single trees.

Until real stand data comes (PAT's forest management plans, or canopy
height from LiDAR), the attributes are placeholders: the dominant species
follows the altitude, roughly as the vegetation belts of these slopes do,
and so does the density; the age is the same everywhere.
"""

# Altitude belts, metres above sea level: the dominant species, a
# placeholder mix (shares of the trees) and a placeholder density of grown
# trees, roughly that of the Alps' high forest: spruce closest together,
# larch woods open.
BELTS: list[tuple[float, str, dict[str, float], int]] = [
    # (upper limit, dominant species, mix, trees per hectare)
    (1000.0, "beech", {"beech": 0.6, "spruce": 0.3, "larch": 0.1}, 300),
    (1600.0, "spruce", {"spruce": 0.7, "larch": 0.2, "beech": 0.1}, 400),
    (float("inf"), "larch", {"larch": 0.6, "spruce": 0.4}, 250),
]

DEFAULT_AGE_CLASS = "mature"

# The species the cards and the stands know, for the frontend's labels.
SPECIES = ["spruce", "larch", "beech", "mixed"]


def belt_of(elevation_m: float) -> int:
    return next(i for i, (upper, *_) in enumerate(BELTS) if elevation_m < upper)


def stand_properties(belt: int, elevation_m: float, area_ha: float) -> dict:
    _, species, mix, density = BELTS[belt]
    return {
        "species": species,
        "species_mix": mix,
        "density_per_ha": density,
        "age_class": DEFAULT_AGE_CLASS,
        "elevation_m": round(elevation_m),
        "area_ha": round(area_ha, 2),
    }


# A planting: young trees, closer together than a grown stand.
PLANTING_DENSITY_PER_HA = 2000


def planting_properties(species: str, planted_year: int) -> dict:
    """A planting's properties; the model adds its age, year by year."""
    mix = {species: 1.0} if species != "mixed" else {"spruce": 0.4, "larch": 0.3, "beech": 0.3}
    return {
        "species": species,
        "species_mix": mix,
        "density_per_ha": PLANTING_DENSITY_PER_HA,
        "age_class": "young",
        "planted_year": planted_year,
    }
