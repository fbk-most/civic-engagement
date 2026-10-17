from typing import Any, Literal

from pydantic import BaseModel, Field

ElementType = Literal[
    "building", "tree", "bench", "water_feature", "path",
    "streetlight", "playground", "fitness_area", "pergola", "kiosk",
    "street", "crossing", "traffic_signal", "lane_divider",
]
CoverType = Literal[
    "paving", "lawn", "meadow", "wood", "water", "gravel", "permeable_paving",
    "playground_surface", "sport_surface",
]
Source = Literal["baseline", "intervention"]
CardType = Literal[
    "plant_tree", "new_path", "change_ground_cover", "plant_grove",
    "add_streetlight", "add_bench", "add_pergola", "add_kiosk",
    "add_playground", "add_fitness_area", "add_streetlight_path", "plant_tree_row",
]
CardCategory = Literal["vegetazione", "copertura_suolo", "elementi_architettonici", "sociale"]
PlacementType = Literal["point", "polyline", "area"]


class DiscreteElement(BaseModel):
    id: str
    type: ElementType
    geometry: dict[str, Any]
    properties: dict[str, Any] = {}
    source: Source
    intervention_id: str | None = None


class CoverPolygon(BaseModel):
    id: str
    geometry: dict[str, Any]
    cover_type: CoverType
    source: Source
    intervention_id: str | None = None


class BaselineScene(BaseModel):
    site_boundary: dict[str, Any]
    elements: list[DiscreteElement]
    covers: list[CoverPolygon]


class Intervention(BaseModel):
    id: str
    card_type: CardType
    geometry: dict[str, Any]
    params: dict[str, Any]
    deleted: bool = False
    created_at: str
    replaces_element_id: str | None = Field(
        default=None,
        description="Set when this plant_tree intervention replants a cut baseline tree, "
        "so its stump is suppressed once this intervention is active",
    )
    planted_year: int = Field(
        default=0,
        description="The `t` the facilitator was viewing when this intervention was created. "
        "Tree growth is computed from `t - planted_year`, not raw `t`, so a tree placed while "
        "viewing +10y doesn't appear already 10 years grown; only relevant for replants, where "
        "it also gates when the new tree appears / the old stump is suppressed.",
    )


class InterventionCreate(BaseModel):
    card_type: CardType
    geometry: dict[str, Any]
    params: dict[str, Any]
    replaces_element_id: str | None = None


class InterventionUpdate(BaseModel):
    params: dict[str, Any]


class ParamSpec(BaseModel):
    key: str
    label: str
    label_en: str
    type: Literal["select", "number", "text"]
    default: Any
    options: list[str] | None = None
    min: float | None = None
    max: float | None = None


class ScenarioInfo(BaseModel):
    """A saved scenario, as listed — see civic_engagement/store/scenarios.py."""

    id: str = Field(description="Its file name, a slug of the name; what the load/delete routes take")
    name: str
    saved_at: str | None = Field(default=None, description="ISO 8601, UTC; None for a hand-made file")
    interventions: int = Field(description="How many interventions it holds")


class ScenarioSave(BaseModel):
    name: str
    overwrite: bool = Field(default=False, description="Replace a scenario with the same id")


class CardSpec(BaseModel):
    card_type: CardType
    label: str
    label_en: str
    category: CardCategory
    placement_type: PlacementType
    params: list[ParamSpec]


class CO2Indicator(BaseModel):
    annual_rate_kg: float
    cumulative_kg: float


class ThermalComfort(BaseModel):
    """Felt temperature over the site's open space at a fixed reference
    moment (parameters.THERMAL_REFERENCE: a midsummer late morning), whatever
    date and hour the 3D view shows."""

    felt_temperature_c: float = Field(description="Mean felt temperature")
    heat_stress_pct: float = Field(description="% of the open space at or above the heat-stress threshold")
    sunlit_pct: float = Field(description="% of the open space in the sun")


class Accessibility(BaseModel):
    walkability_score: float | None
    fragile_path_pct: float | None


class AgeInclusivity(BaseModel):
    bambini: bool
    giovani: bool
    generale: bool


class SocialIndicators(BaseModel):
    safety_score: float
    evening_winter_score: float
    age_inclusivity: AgeInclusivity


class MaintenanceIndicator(BaseModel):
    """The upkeep the interventions add (the existing square's isn't counted)."""

    annual_eur: float = Field(description="In the year shown")
    cumulative_eur: float = Field(description="Paid from now up to (not including) the year shown")


class Indicators(BaseModel):
    space_use_pct: dict[str, float]
    co2: CO2Indicator
    thermal_comfort: ThermalComfort | None = Field(
        default=None,
        description="Null in a scene (GET /indicators/thermal has it, so a scene doesn't wait for two "
        "fields); set in the yearly series.",
    )
    accessibility: Accessibility
    social: SocialIndicators
    cost_eur: float
    maintenance: MaintenanceIndicator


class ThermalIndicators(BaseModel):
    """The thermal indicators at year t, with and without the interventions."""

    t: int
    scenario: ThermalComfort
    baseline: ThermalComfort


class IndicatorSeries(BaseModel):
    years: list[int] = Field(description="Year offsets from now, one per entry of the two series")
    baseline: list[Indicators] = Field(description="Indicators with no interventions, per year")
    scenario: list[Indicators] = Field(description="Indicators with the session's interventions, per year")


class FieldGrid(BaseModel):
    """Where a field's cells are: in the 3D view's local frame (metres east
    and north of the anchor, see frontend/src/three/geo.ts), cell (i, j)
    spans x0 + i*cell_m .. x0 + (i+1)*cell_m east, y0 + j*cell_m ..
    y0 + (j+1)*cell_m north."""

    anchor_lng: float
    anchor_lat: float
    x0: float
    y0: float
    nx: int
    ny: int
    cell_m: float


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


class SceneResponse(BaseModel):
    site_id: str = Field(description="Which site this is (config.py's SITES key), e.g. for naming exports.")
    site_name: str = Field(default="", description="The site's display name, e.g. \"Piazza Dante, Utopia\".")
    site_boundary: dict[str, Any]
    boundary_status: str = Field(
        description="\"surveyed\": site_boundary is real digitized/sourced data. \"provisional\": a "
        "placeholder (e.g. a plain circle) standing in until real data is digitized — see "
        "config.py's SiteConfig.boundary_status. The frontend only draws the boundary outline "
        "on the map for a surveyed site, since a provisional one isn't a real shape to show."
    )
    elements: list[DiscreteElement]
    covers: list[CoverPolygon]
    t: int = Field(description="Years offset from now (0, 5, or 10)")
    indicators: Indicators
    baseline_indicators: Indicators = Field(
        description="Same indicators computed with zero interventions, for contribution comparison"
    )
    interventions: list[Intervention] = Field(
        description="Active (non-deleted) interventions, so the frontend can render one card per "
        "placed intervention without a second round trip"
    )
    revision: str = Field(
        default="",
        description="The session's revision this scene was computed from (see GET /session/revision): "
        "a window compares the two to tell whether another window changed the session.",
    )
