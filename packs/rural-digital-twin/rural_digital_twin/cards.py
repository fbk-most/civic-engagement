"""The rural pack's intervention cards: as few as possible for now, the two
basic forestry interventions. Both are areas: what the model will track is
the forest, not single trees."""

from civic_engagement.models.schema import CardSpec

CARDS: list[CardSpec] = [
    CardSpec(
        card_type="plant_forest",
        label="Rimboschimento",
        label_en="Planting",
        category="bosco",
        placement_type="area",
        params=[
            {
                "key": "species",
                "label": "Specie",
                "label_en": "Species",
                "type": "select",
                "default": "mixed",
                "options": ["spruce", "larch", "beech", "mixed"],
            },
        ],
    ),
    CardSpec(
        card_type="fell_forest",
        label="Taglio",
        label_en="Felling",
        category="bosco",
        placement_type="area",
        params=[],
    ),
]

# The cover each card's area becomes.
COVER_OF_CARD = {"plant_forest": "planting", "fell_forest": "felling"}
