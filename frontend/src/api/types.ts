export type ElementType =
  | "building"
  | "tree"
  | "bench"
  | "water_feature"
  | "path"
  | "streetlight"
  | "playground"
  | "fitness_area"
  | "pergola"
  | "kiosk"
  | "street"
  | "crossing"
  | "traffic_signal"
  | "lane_divider";
export type CoverType =
  | "paving"
  | "lawn"
  | "meadow"
  | "wood"
  | "water"
  | "gravel"
  | "permeable_paving"
  | "playground_surface"
  | "sport_surface";
export type Source = "baseline" | "intervention";

export interface DiscreteElement {
  id: string;
  type: ElementType;
  geometry: GeoJSON.Geometry;
  properties: Record<string, unknown>;
  source: Source;
  intervention_id: string | null;
}

export interface CoverPolygon {
  id: string;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  cover_type: CoverType;
  source: Source;
  intervention_id: string | null;
}

export interface BaselineScene {
  site_boundary: GeoJSON.Polygon;
  elements: DiscreteElement[];
  covers: CoverPolygon[];
}

export interface CO2Indicator {
  annual_rate_kg: number;
  cumulative_kg: number;
}

/** Felt temperature over the site's open space at a fixed reference moment
 * (a midsummer late morning, see THERMAL_REFERENCE in
 * packs/bologna-civic-dt/bologna_civic_dt/parameters.py), whatever the 3D view's clock says. */
/** The thermal indicators at year t, with and without the interventions. */
export interface ThermalIndicators {
  t: number;
  scenario: ThermalComfort;
  baseline: ThermalComfort;
}

export interface ThermalComfort {
  felt_temperature_c: number;
  /** % of the open space at or above the heat-stress threshold. */
  heat_stress_pct: number;
  /** % of the open space in the sun. */
  sunlit_pct: number;
}

export interface Accessibility {
  walkability_score: number | null;
  fragile_path_pct: number | null;
}

export interface AgeInclusivity {
  bambini: boolean;
  giovani: boolean;
  generale: boolean;
}

export interface SocialIndicators {
  safety_score: number;
  evening_winter_score: number;
  age_inclusivity: AgeInclusivity;
}

export interface Indicators {
  space_use_pct: Record<string, number>;
  co2: CO2Indicator;
  /** Null in a scene: the thermal indicators come apart (fetchThermalIndicators). */
  thermal_comfort: ThermalComfort | null;
  accessibility: Accessibility;
  social: SocialIndicators;
  cost_eur: number;
  maintenance: MaintenanceIndicator;
}

/** The upkeep the interventions add (the existing square's isn't counted). */
export interface MaintenanceIndicator {
  annual_eur: number;
  /** Paid from now up to (not including) the year shown. */
  cumulative_eur: number;
}

/** Every indicator for every year of the horizon (`years`), with and
 * without the session's interventions — see GET /api/indicators/series. */
export interface IndicatorSeries {
  years: number[];
  baseline: Indicators[];
  scenario: Indicators[];
}

export interface SceneResponse extends BaselineScene {
  /** Which site this is (config.py's SITES key), e.g. for naming exports. */
  site_id: string;
  /** The site's display name, e.g. "Piazza Dante, Utopia". */
  site_name: string;
  /** "surveyed": site_boundary is real digitized/sourced data. "provisional":
   * a placeholder (e.g. a plain circle) standing in until real data is
   * digitized — see civic_engagement/config.py's SiteConfig.boundary_status. Only
   * a surveyed boundary is drawn on the map (see map/layers.ts). */
  boundary_status: "surveyed" | "provisional";
  t: number;
  indicators: Indicators;
  baseline_indicators: Indicators;
  interventions: Intervention[];
  /** The session's revision this scene reflects (see fetchSessionRevision). */
  revision: string;
}

/** A saved scenario, as listed — see GET /api/scenarios. */
export interface ScenarioInfo {
  /** What the load/delete calls take: a slug of the name. */
  id: string;
  name: string;
  /** ISO 8601; null for a hand-made file. */
  saved_at: string | null;
  /** How many interventions it holds. */
  interventions: number;
}

export type CardType =
  | "plant_tree"
  | "new_path"
  | "change_ground_cover"
  | "plant_grove"
  | "add_streetlight"
  | "add_bench"
  | "add_pergola"
  | "add_kiosk"
  | "add_playground"
  | "add_fitness_area"
  | "add_streetlight_path"
  | "plant_tree_row";
export type CardCategory = "vegetazione" | "copertura_suolo" | "elementi_architettonici" | "sociale";
export type PlacementType = "point" | "polyline" | "area";

/** How placed interventions render on the 2D map: `hidden` shows only the
 * baseline (current situation), `cards` shows a colored marker at each
 * intervention's placement point without its full geometry (the proposed
 * "what if" — cards on the table, not yet simulated), `simulated` renders
 * the full resolved geometry. */
export type InterventionDisplayMode = "hidden" | "cards" | "simulated";

export interface ParamSpec {
  key: string;
  /** Italian; `label_en` is the English one (see i18n/labels.ts's paramLabel). */
  label: string;
  label_en: string;
  type: "select" | "number" | "text";
  default: unknown;
  options: string[] | null;
  min: number | null;
  max: number | null;
}

export interface CardSpec {
  card_type: CardType;
  /** Italian; `label_en` is the English one (see i18n/labels.ts's cardLabel). */
  label: string;
  label_en: string;
  category: CardCategory;
  placement_type: PlacementType;
  params: ParamSpec[];
}

export interface Intervention {
  id: string;
  card_type: CardType;
  geometry: GeoJSON.Geometry;
  params: Record<string, unknown>;
  deleted: boolean;
  created_at: string;
  replaces_element_id: string | null;
  planted_year: number;
}

export interface InterventionCreate {
  card_type: CardType;
  geometry: GeoJSON.Geometry;
  params: Record<string, unknown>;
  replaces_element_id?: string | null;
}

export type AgeClass = "sapling" | "young" | "mature" | "veteran";
export type TreeStatus = "alive" | "stump";

export interface TreeProperties {
  species: string;
  age_class: AgeClass;
  canopy_diameter: number;
  height: number;
  cut_year: number | null;
  status: TreeStatus;
}

/** Where a field's cells are, in the 3D view's local frame (see three/geo.ts):
 * cell (i, j) spans x0 + i*cell_m .. +cell_m east, y0 + j*cell_m .. +cell_m
 * north of the anchor. */
export interface FieldGrid {
  anchor_lng: number;
  anchor_lat: number;
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  cell_m: number;
}

/** Felt temperature across the site, hour by hour on one day — see GET
 * /api/thermal-field. `data` is base64, one byte per cell (hour, then row from
 * the south, then column from the west): offset + byte * scale °C, or nodata. */
export interface ThermalFieldResponse {
  t: number;
  date: string;
  scenario: "current" | "as_is";
  grid: FieldGrid;
  hours: number;
  data: string;
  scale: number;
  offset: number;
  nodata: number;
  air_temperature_c: number[];
  mean_felt_c: number[];
  heat_stress_pct: number[];
  sunlit_pct: number[];
}
