"""The urban pack's types: element, cover and card types (the core's
schema has them as plain strings, see civic_engagement/domain.py), and the
felt-temperature field as served."""

from typing import Literal, get_args

from pydantic import BaseModel, Field

from civic_engagement.models.schema import FieldGrid

ElementType = Literal[
    "building", "tree", "bench", "water_feature", "path",
    "streetlight", "playground", "fitness_area", "pergola", "kiosk",
    "street", "crossing", "traffic_signal", "lane_divider",
]
CoverType = Literal[
    "paving", "lawn", "meadow", "wood", "water", "gravel", "permeable_paving",
    "playground_surface", "sport_surface",
]
CardType = Literal[
    "plant_tree", "new_path", "change_ground_cover", "plant_grove",
    "add_streetlight", "add_bench", "add_pergola", "add_kiosk",
    "add_playground", "add_fitness_area", "add_streetlight_path", "plant_tree_row",
]
CardCategory = Literal["vegetazione", "copertura_suolo", "elementi_architettonici", "sociale"]

ELEMENT_TYPES = frozenset(get_args(ElementType))
COVER_TYPE_SET = frozenset(get_args(CoverType))


class ThermalFieldResponse(BaseModel):
    t: int
    date: str = Field(description="ISO date the field is computed for")
    scenario: Literal["current", "as_is"]
    grid: FieldGrid
    hours: int = Field(description="Hourly layers, from 00:00 local time")
    data: str = Field(
        description="Felt temperature, base64 of one byte per cell: hour by hour, each hour row by row "
        "from the southern row, each row west to east. Byte b is offset + b * scale °C; nodata "
        "(outside the site, inside buildings) is 255."
    )
    scale: float
    offset: float
    nodata: int
    air_temperature_c: list[float] = Field(description="Per hour")
    mean_felt_c: list[float] = Field(description="Per hour, over the open space")
    heat_stress_pct: list[float] = Field(description="Per hour, over the open space")
    sunlit_pct: list[float] = Field(description="Per hour, over the open space")
