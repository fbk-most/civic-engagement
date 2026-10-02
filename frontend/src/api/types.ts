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

export interface ThermalComfort {
  estimated_temperature_c: number;
  cooling_delta_c: number;
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
  thermal_comfort: ThermalComfort;
  accessibility: Accessibility;
  social: SocialIndicators;
  cost_eur: number;
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
  /** "surveyed": site_boundary is real digitized/sourced data. "provisional":
   * a placeholder (e.g. a plain circle) standing in until real data is
   * digitized — see civic_twin/config.py's SiteConfig.boundary_status. Only
   * a surveyed boundary is drawn on the map (see map/layers.ts). */
  boundary_status: "surveyed" | "provisional";
  t: number;
  indicators: Indicators;
  baseline_indicators: Indicators;
  interventions: Intervention[];
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
  | "add_fitness_area";
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
  label: string;
  type: "select" | "number" | "text";
  default: unknown;
  options: string[] | null;
  min: number | null;
  max: number | null;
}

export interface CardSpec {
  card_type: CardType;
  label: string;
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
