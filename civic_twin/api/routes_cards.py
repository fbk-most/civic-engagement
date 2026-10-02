from fastapi import APIRouter

from civic_twin.models.schema import CardSpec

router = APIRouter()

CARDS: list[CardSpec] = [
    CardSpec(
        card_type="plant_tree",
        label="Pianta un albero",
        category="vegetazione",
        placement_type="point",
        params=[
            {
                "key": "species",
                "label": "Specie",
                "type": "select",
                "default": "unknown",
                "options": ["oak", "birch", "linden", "plane", "elm", "ginkgo", "horse_chestnut", "cypress", "pine", "unknown"],
            },
            {
                "key": "canopy_diameter",
                "label": "Diametro della chioma alla piantumazione (m)",
                "type": "number",
                "default": 1.0,
                "min": 0.5,
                "max": 3.0,
            },
        ],
    ),
    CardSpec(
        card_type="new_path",
        label="Nuovo percorso",
        category="elementi_architettonici",
        placement_type="polyline",
        params=[
            {
                "key": "width",
                "label": "Larghezza (m)",
                "type": "number",
                "default": 2.0,
                "min": 0.5,
                "max": 6.0,
            },
            {
                "key": "material",
                "label": "Materiale",
                "type": "select",
                "default": "gravel",
                "options": ["gravel", "permeable_paving", "wood"],
            },
        ],
    ),
    CardSpec(
        card_type="change_ground_cover",
        label="Cambia copertura del suolo",
        category="copertura_suolo",
        placement_type="area",
        params=[
            {
                "key": "cover_type",
                "label": "Copertura di destinazione",
                "type": "select",
                "default": "meadow",
                "options": ["lawn", "meadow", "wood", "permeable_paving"],
            },
        ],
    ),
    CardSpec(
        card_type="plant_grove",
        label="Pianta un boschetto",
        category="vegetazione",
        placement_type="area",
        params=[
            {
                "key": "species",
                "label": "Specie",
                "type": "select",
                "default": "unknown",
                "options": ["oak", "birch", "linden", "plane", "elm", "ginkgo", "horse_chestnut", "cypress", "pine", "unknown"],
            },
            {
                "key": "spacing",
                "label": "Distanza tra gli alberi (m)",
                "type": "number",
                "default": 5.0,
                "min": 3.0,
                "max": 10.0,
            },
        ],
    ),
    CardSpec(
        card_type="add_streetlight",
        label="Illuminazione",
        category="sociale",
        placement_type="point",
        params=[],
    ),
    CardSpec(
        card_type="add_bench",
        label="Panchina",
        category="sociale",
        placement_type="point",
        params=[],
    ),
    CardSpec(
        card_type="add_pergola",
        label="Pergola / gazebo coperto",
        category="sociale",
        placement_type="point",
        params=[
            {
                "key": "size",
                "label": "Dimensione",
                "type": "select",
                "default": "medium",
                "options": ["small", "medium", "large"],
            },
        ],
    ),
    CardSpec(
        card_type="add_kiosk",
        label="Chiosco / punto ristoro",
        category="sociale",
        placement_type="point",
        params=[],
    ),
    CardSpec(
        card_type="add_playground",
        label="Area giochi bambini",
        category="sociale",
        placement_type="area",
        params=[
            {
                "key": "age_range",
                "label": "Fascia d'età",
                "type": "select",
                "default": "junior",
                "options": ["junior", "mixed"],
            },
        ],
    ),
    CardSpec(
        card_type="add_fitness_area",
        label="Area fitness / ritrovo giovani",
        category="sociale",
        placement_type="area",
        params=[
            {
                "key": "target_age",
                "label": "Destinatari",
                "type": "select",
                "default": "teens",
                "options": ["teens", "mixed"],
            },
        ],
    ),
]


@router.get("/cards", response_model=list[CardSpec])
def get_cards() -> list[CardSpec]:
    return CARDS
