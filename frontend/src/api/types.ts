// Element, cover and card types, and card categories, are the domain
// pack's: plain strings to the core, as in the backend's schema.
export type ElementType = string;
export type CoverType = string;
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

/** An indicator's value: a number (null where it can't be computed),
 * `{part: number}` for a breakdown, `{part: boolean}` for flags. */
export type IndicatorValue = number | null | Record<string, number> | Record<string, boolean>;

/** Indicator values keyed by descriptor id (see IndicatorDescriptor). */
export type IndicatorValues = Record<string, IndicatorValue>;

/** A section of indicators, in display order; a null label shows it
 * without a heading. */
export interface IndicatorGroup {
  id: string;
  label: string | null;
  label_en: string | null;
}

export interface IndicatorPart {
  id: string;
  label: string;
  label_en: string;
}

/** How to show one indicator, as the domain declares it — see GET
 * /api/indicators/descriptors and civic_engagement/models/schema.py. */
export interface IndicatorDescriptor {
  id: string;
  group: string;
  label: string;
  label_en: string;
  /** For the key indicators panel; label if null. */
  short_label: string | null;
  short_label_en: string | null;
  kind: "number" | "breakdown" | "flags";
  /** Appended to the value as is (e.g. " °C", "%"). */
  unit: string;
  /** unit if null. */
  unit_en: string | null;
  decimals: number;
  /** Which way a change counts as an improvement; null: neither. */
  better: "higher" | "lower" | null;
  /** Only meaningful with interventions (e.g. their cost): no "current" value. */
  scenario_only: boolean;
  /** Shown in the key indicators panel. */
  key: boolean;
  /** Shown in the "Indicators" tab. */
  chart: boolean;
  /** Too slow for the scene: fetched apart (fetchDeferredIndicators). */
  deferred: boolean;
  /** The parts of a breakdown or flags indicator, in display order (none
   * for the space use breakdown, whose parts are the cover types). */
  parts: IndicatorPart[];
}

export interface IndicatorDescriptors {
  groups: IndicatorGroup[];
  indicators: IndicatorDescriptor[];
}

/** The deferred indicators at year t, with and without the interventions. */
export interface DeferredIndicators {
  t: number;
  scenario: IndicatorValues;
  baseline: IndicatorValues;
}

/** Every indicator for every year of the horizon (`years`), with and
 * without the session's interventions — see GET /api/indicators/series. */
export interface IndicatorSeries {
  years: number[];
  baseline: IndicatorValues[];
  scenario: IndicatorValues[];
}

export interface SceneResponse extends BaselineScene {
  /** Which site this is (its key in the pack's sites), e.g. for naming exports. */
  site_id: string;
  /** The site's display name, e.g. "Piazza Dante, Utopia". */
  site_name: string;
  /** "surveyed": site_boundary is real digitized/sourced data. "provisional":
   * a placeholder (e.g. a plain circle) standing in until real data is
   * digitized — see civic_engagement/config.py's SiteConfig.boundary_status. Only
   * a surveyed boundary is drawn on the map (see map/layers.ts). */
  boundary_status: "surveyed" | "provisional";
  t: number;
  /** Every indicator but the deferred ones. */
  indicators: IndicatorValues;
  baseline_indicators: IndicatorValues;
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

export type CardType = string;
export type CardCategory = string;
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

/** The ground's height on a grid of points (see the backend's
 * `TerrainGrid` and three/terrain.ts): point (col, row) is x0 + col*cell_m
 * east and z0 + row*cell_m *south* of the anchor; `heights` is base64 of
 * little-endian uint16 levels of `height_scale_m`, row-major. */
export interface TerrainGrid {
  anchor_lng: number;
  anchor_lat: number;
  x0: number;
  z0: number;
  cols: number;
  rows: number;
  cell_m: number;
  base_elevation_m: number;
  height_scale_m: number;
  heights: string;
}

/** A file the frontend loads apart from the scene (see the backend's
 * site_assets.py). */
export interface SiteAsset {
  key: string;
  format: string;
  bytes: number;
  version: string;
  metadata: Record<string, unknown>;
}

export interface SiteAssets {
  site_id: string;
  assets: SiteAsset[];
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
