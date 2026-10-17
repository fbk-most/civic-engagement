from typing import Any, Literal

from pydantic import BaseModel, Field

# Element, cover and card types are the domain pack's (see domain.py: the
# core checks them against the pack's).
ElementType = str
CoverType = str
CardType = str
CardCategory = str
Source = Literal["baseline", "intervention"]
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


IndicatorValue = float | dict[str, bool] | dict[str, float] | None
# Indicator values keyed by descriptor id (see IndicatorDescriptor): a number
# (None where it can't be computed), {part: number} for a breakdown,
# {part: bool} for flags.
IndicatorValues = dict[str, IndicatorValue]


class IndicatorGroup(BaseModel):
    """A section of indicators, in display order."""

    id: str
    label: str | None = Field(default=None, description="None: shown without a heading")
    label_en: str | None = None


class IndicatorPart(BaseModel):
    id: str
    label: str
    label_en: str


class IndicatorDescriptor(BaseModel):
    """How to show one indicator: the frontend knows indicators only through
    these, which the domain declares."""

    id: str
    group: str = Field(description="An IndicatorGroup id")
    label: str
    label_en: str
    short_label: str | None = Field(default=None, description="For the key indicators panel; label if None")
    short_label_en: str | None = None
    kind: Literal["number", "breakdown", "flags"]
    unit: str = Field(default="", description="Appended to the value as is (e.g. \" °C\", \"%\")")
    unit_en: str | None = Field(default=None, description="unit if None")
    decimals: int = 0
    better: Literal["higher", "lower"] | None = Field(default=None, description="Which way is an improvement")
    scenario_only: bool = Field(default=False, description="Only meaningful with interventions (e.g. their cost)")
    key: bool = Field(default=False, description="Shown in the key indicators panel")
    chart: bool = Field(default=True, description="Shown in the Indicators tab")
    deferred: bool = Field(
        default=False,
        description="Too slow for the scene: served by GET /indicators/deferred instead (and in the series)",
    )
    parts: list[IndicatorPart] = Field(
        default_factory=list, description="The parts of a breakdown or flags indicator, in display order"
    )


class IndicatorDescriptors(BaseModel):
    groups: list[IndicatorGroup]
    indicators: list[IndicatorDescriptor]


class DeferredIndicators(BaseModel):
    """The deferred indicators at year t, with and without the interventions."""

    t: int
    scenario: IndicatorValues
    baseline: IndicatorValues


class IndicatorSeries(BaseModel):
    years: list[int] = Field(description="Year offsets from now, one per entry of the two series")
    baseline: list[IndicatorValues] = Field(description="Every indicator with no interventions, per year")
    scenario: list[IndicatorValues] = Field(description="Every indicator with the session's interventions, per year")


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


class SceneResponse(BaseModel):
    site_id: str = Field(description="Which site this is (its key in the pack's sites), e.g. for naming exports.")
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
    indicators: IndicatorValues = Field(description="Every indicator but the deferred ones")
    baseline_indicators: IndicatorValues = Field(
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
