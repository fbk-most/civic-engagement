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
    "add_playground", "add_fitness_area",
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
    type: Literal["select", "number", "text"]
    default: Any
    options: list[str] | None = None
    min: float | None = None
    max: float | None = None


class CardSpec(BaseModel):
    card_type: CardType
    label: str
    category: CardCategory
    placement_type: PlacementType
    params: list[ParamSpec]


class CO2Indicator(BaseModel):
    annual_rate_kg: float
    cumulative_kg: float


class ThermalComfort(BaseModel):
    estimated_temperature_c: float
    cooling_delta_c: float


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


class Indicators(BaseModel):
    space_use_pct: dict[str, float]
    co2: CO2Indicator
    thermal_comfort: ThermalComfort
    accessibility: Accessibility
    social: SocialIndicators
    cost_eur: float


class IndicatorSeries(BaseModel):
    years: list[int] = Field(description="Year offsets from now, one per entry of the two series")
    baseline: list[Indicators] = Field(description="Indicators with no interventions, per year")
    scenario: list[Indicators] = Field(description="Indicators with the session's interventions, per year")


class SceneResponse(BaseModel):
    site_id: str = Field(description="Which site this is (config.py's SITES key), e.g. for naming exports.")
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
