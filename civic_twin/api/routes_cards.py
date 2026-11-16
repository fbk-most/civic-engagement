from math import isfinite

from fastapi import APIRouter, HTTPException

from civic_twin.domains.urban.parameters import CULTIVATION_COVER, DEFAULT_CULTIVATION
from civic_twin.models.schema import CardSpec, ParamSpec

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
        card_type="cultivate_terrain",
        label="Coltiva il terreno",
        category="copertura_suolo",
        placement_type="area",
        params=[
            {
                "key": "cover_type",
                "label": "Coltura",
                "type": "select",
                "default": DEFAULT_CULTIVATION,
                "options": list(CULTIVATION_COVER),
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


def _problem(spec: ParamSpec, value: object) -> str | None:
    """Why `value` is not allowed for this parameter, or None if it is."""
    if spec.type == "select":
        if value not in (spec.options or []):
            return f"{spec.key}: {value!r} is not one of {spec.options}"
    elif spec.type == "number":
        # A bool is an int in Python, but it is not a number here.
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
            return f"{spec.key}: {value!r} is not a number"
        if (spec.min is not None and value < spec.min) or (spec.max is not None and value > spec.max):
            return f"{spec.key}: {value} is not between {spec.min} and {spec.max}"
    elif not isinstance(value, str):
        return f"{spec.key}: {value!r} is not text"
    return None


def validate_params(card_type: str, params: dict) -> None:
    """Refuses (422) parameters the card's spec does not allow: a parameter
    the card does not have, a value of the wrong type, a select value outside
    its options, a number outside its range. A parameter left out is fine: the
    layout takes its default. The spec is the one source of what is valid, so
    a new card is checked as soon as it is declared in `CARDS`, and nothing
    invalid is stored for the scene to fail on later."""
    card = next((c for c in CARDS if c.card_type == card_type), None)
    if card is None:
        raise HTTPException(status_code=422, detail=f"unknown card: {card_type}")
    specs = {spec.key: spec for spec in card.params}
    problems = [
        f"{key}: not a parameter of {card_type}" if key not in specs else _problem(specs[key], value)
        for key, value in params.items()
    ]
    problems = [problem for problem in problems if problem]
    if problems:
        raise HTTPException(status_code=422, detail="; ".join(problems))
