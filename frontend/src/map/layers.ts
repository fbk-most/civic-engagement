import {
  GeoJSONSource,
  type MapLibreMap,
  type LngLatBoundsLike,
  type ExpressionSpecification,
  type LayerSpecification,
} from "maplibre-gl";
import type { CardSpec, DiscreteElement, InterventionDisplayMode, SceneResponse } from "../api/types";
import { activePack } from "../pack";
import { anchorFromPolygon, representativePoint, toLocal, toLngLat, type GeoAnchor } from "../three/geo";
import { hashString } from "../three/hash";
import { buildCardMarkerImage } from "./cardMarkerIcons";
import { OCCLUDED_OPACITY, refreshOcclusion, setOcclusionInputs } from "./occlusion";

// How often occlusion re-evaluates while the camera is actively being
// dragged (see the `move` listener in `renderScene`) — frequent enough to
// read as live, not so frequent that a long drag/rotate is doing real work
// (`markers x buildings`) every single animation frame for no visible gain.
const OCCLUSION_MOVE_REFRESH_MS = 150;

/** One layer of the domain's elements on the 2D map, as the pack declares it
 * (`FrontendPack.map.layers`); the core makes the sources and layers, in the
 * pack's order, and wires occlusion and clicks. */
export interface MapElementLayer {
  /** The layer's id. */
  id: string;
  /** The source the layer draws, holding the elements of `types`: several
   * layers may share one. */
  source: string;
  types: string[];
  /** A point layer of physical things a building can hide from the camera
   * (see `occlusion.ts`): its style should dim them with `dimIfOccluded`. */
  occludable?: boolean;
  /** "select": clicking a placed intervention's feature selects it.
   * "tree": a tree, opening its identity card (or its intervention). */
  interaction?: "select" | "tree";
  /** The MapLibre layer, but for its id and source. */
  style: (helpers: MapLayerHelpers) => LayerStyle;
}

type LayerStyle = LayerSpecification extends infer L
  ? L extends LayerSpecification
    ? Omit<L, "id" | "source">
    : never
  : never;

export interface MapLayerHelpers {
  /** A `line-width` (or `circle-radius`) for a real-world width in metres,
   * the feature's `width` property or `defaultWidthM`, at every zoom (see
   * `realWidthLineWidth`). */
  realWidth: (defaultWidthM: number, exaggeration?: number, minPx?: number) => ExpressionSpecification;
  /** How much real-world line widths are exaggerated by default. */
  lineWidthExaggeration: number;
  /** An opacity, dimmed while a building hides the feature (see
   * `occlusion.ts`). */
  dimIfOccluded: (baseOpacity: number) => ExpressionSpecification;
}

/** Building occlusion (see `occlusion.ts`) dims a marker instead of hiding
 * it; every point layer that represents a real, physical piece of site
 * furniture opts into this via its `circle-opacity`. */
function dimIfOccluded(baseOpacity: number): ExpressionSpecification {
  return [
    "case",
    ["boolean", ["feature-state", "occluded"], false],
    OCCLUDED_OPACITY,
    baseOpacity,
  ] as unknown as ExpressionSpecification;
}

/** Real-world size of a "card" marker, roughly a playing card's proportions —
 * small enough to read as a token placed on the map, not a footprint. */
const CARD_MARKER_WIDTH_M = 3;
const CARD_MARKER_HEIGHT_M = 4.2;

function featureCollection(features: GeoJSON.Feature[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features };
}

function elementsToFeatures(elements: DiscreteElement[]): GeoJSON.Feature[] {
  return elements.map((el) => ({
    type: "Feature",
    id: el.id,
    geometry: el.geometry,
    properties: {
      ...el.properties,
      elementId: el.id,
      elementType: el.type,
      source: el.source,
      interventionId: el.intervention_id,
    },
  }));
}

/** -12..+12 degrees, deterministic per intervention id — shared by the card
 * polygon, its shadow, and its icon (`icon-rotate`) so all three agree on
 * how far this particular card is tilted. */
function cardRotationDeg(seed: string): number {
  return (hashString(seed) % 25) - 12;
}

function rectPolygonAtLocal(
  anchor: GeoAnchor,
  cx: number,
  cz: number,
  rotationDeg: number,
  width: number,
  height: number
): GeoJSON.Polygon {
  const angle = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const halfW = width / 2;
  const halfH = height / 2;

  const corners: [number, number][] = [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ].map(([dx, dz]) => [cx + dx * cos - dz * sin, cz + dx * sin + dz * cos]);

  const ring = [...corners, corners[0]].map(([x, z]) => toLngLat(anchor, x, z));
  return { type: "Polygon", coordinates: [ring] };
}

/** A small rectangle around `point`, in real-world metres, standing in for a
 * physical card placed on the paper map — the origin metaphor this tool
 * reimplements (see project notes). */
function cardShapePolygon(
  anchor: GeoAnchor,
  point: [number, number],
  rotationDeg: number
): GeoJSON.Polygon {
  const [cx, cz] = toLocal(anchor, point[0], point[1]);
  return rectPolygonAtLocal(anchor, cx, cz, rotationDeg, CARD_MARKER_WIDTH_M, CARD_MARKER_HEIGHT_M);
}

/** The same card, shifted a little so it renders as a soft "lifted paper"
 * shadow underneath — a fixed offset, not tied to sun direction, just enough
 * to read as a token sitting slightly above the map rather than a flat
 * sticker on it. */
function cardShadowPolygon(
  anchor: GeoAnchor,
  point: [number, number],
  rotationDeg: number
): GeoJSON.Polygon {
  const [cx, cz] = toLocal(anchor, point[0], point[1]);
  return rectPolygonAtLocal(
    anchor,
    cx + 0.35,
    cz - 0.35,
    rotationDeg,
    CARD_MARKER_WIDTH_M,
    CARD_MARKER_HEIGHT_M
  );
}

function boundaryToBounds(boundary: GeoJSON.Polygon): LngLatBoundsLike {
  const coords = boundary.coordinates[0];
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}

/** (Re)builds every baseline source/layer from a freshly fetched scene. Safe to
 * call again after edits once intervention endpoints exist — sources are
 * replaced wholesale rather than diffed, which is fine at this data scale.
 * `mode` filters client-side, so switching it needs no round trip to the
 * backend: `hidden`/`cards` both render baseline-only geometry, `cards`
 * additionally adds a marker per intervention at its placement point (needs
 * `cards` to look up each intervention's category color). `framing` is the
 * pitch/bearing the site is first fitted with (the 3D view's mini-map wants a
 * flat, north-up plan). */
export function renderScene(
  map: MapLibreMap,
  scene: SceneResponse,
  mode: InterventionDisplayMode,
  cards: CardSpec[],
  framing: { pitch: number; bearing: number; padding: number } = { pitch: 55, bearing: -20, padding: 40 }
): void {
  const showFull = mode === "simulated";
  const elements = showFull ? scene.elements : scene.elements.filter((e) => e.source === "baseline");
  const covers = showFull ? scene.covers : scene.covers.filter((c) => c.source === "baseline");
  const anchor = anchorFromPolygon(scene.site_boundary);

  setOrCreateSource(map, "covers", featureCollection(
    covers.map((c) => ({
      type: "Feature",
      id: c.id,
      geometry: c.geometry,
      properties: { cover_type: c.cover_type, source: c.source, interventionId: c.intervention_id },
    }))
  ));
  const { layers } = activePack().map;
  const sources = new Map<string, { types: Set<string>; occludable: boolean }>();
  for (const layer of layers) {
    const source = sources.get(layer.source) ?? { types: new Set<string>(), occludable: false };
    layer.types.forEach((type) => source.types.add(type));
    source.occludable ||= !!layer.occludable;
    sources.set(layer.source, source);
  }
  const elementsOf = (types: Set<string>) => elements.filter((e) => types.has(e.type));
  // Only occludable sources get a `promoteId` (see `setOrCreateSource`): a
  // flat path or road marking isn't a plausible occlusion target, so
  // nothing ever calls `setFeatureState` on the others.
  for (const [id, { types, occludable }] of sources) {
    setOrCreateSource(map, id, featureCollection(elementsToFeatures(elementsOf(types))), occludable ? "elementId" : undefined);
  }
  // Only a surveyed boundary is real digitized data worth outlining — a
  // provisional one (e.g. Bologna's placeholder circle) isn't a real shape
  // of the square, so it's left undrawn rather than shown as if it were.
  if (scene.boundary_status === "surveyed") {
    setOrCreateSource(map, "site_boundary", featureCollection([
      { type: "Feature", geometry: scene.site_boundary, properties: {} },
    ]));
  }
  setOrCreateSource(map, "highlight", featureCollection([]));
  setOrCreateSource(map, "camera", featureCollection([]));

  const markers: GeoJSON.Feature[] = [];
  const markerShadows: GeoJSON.Feature[] = [];
  if (mode === "cards") {
    // Same rule the model applies to the full geometry: an intervention
    // placed while previewing a later year doesn't exist yet at this t.
    for (const iv of scene.interventions) {
      if (scene.t < iv.planted_year) continue;
      const card = cards.find((c) => c.card_type === iv.card_type);
      const point = representativePoint(iv.geometry);
      const rotationDeg = cardRotationDeg(iv.id);
      markerShadows.push({
        type: "Feature",
        geometry: cardShadowPolygon(anchor, point, rotationDeg),
        properties: {},
      });
      markers.push({
        type: "Feature",
        geometry: cardShapePolygon(anchor, point, rotationDeg),
        properties: {
          category: card?.category ?? "",
          interventionId: iv.id,
          cardType: iv.card_type,
          rotationDeg,
        },
      });
    }
  }
  setOrCreateSource(map, "intervention-marker-shadows", featureCollection(markerShadows));
  setOrCreateSource(map, "intervention-markers", featureCollection(markers));

  // Only frame the site the first time layers are built. Every later call —
  // toggling "Interventi", moving the time slider, editing an intervention —
  // re-runs this function too, and re-fitting the camera on each of those
  // would yank the view away from wherever the facilitator had navigated to.
  const isFirstBuild = !map.getLayer("covers-fill");
  ensureLayers(map, anchor.lat0, scene.boundary_status === "surveyed", layers);
  if (isFirstBuild) {
    map.fitBounds(boundaryToBounds(scene.site_boundary), { ...framing, duration: 0 });
    // Camera pose (pitch/bearing/zoom drag, not just data changes) also
    // affects which markers a building occludes — see `occlusion.ts`. `move`
    // fires continuously through a drag (once a frame), so it's throttled;
    // `moveend` alone would leave markers stale for the whole drag, only
    // catching up once the facilitator lets go.
    let lastOcclusionRefresh = 0;
    map.on("move", () => {
      const now = performance.now();
      if (now - lastOcclusionRefresh < OCCLUSION_MOVE_REFRESH_MS) return;
      lastOcclusionRefresh = now;
      refreshOcclusion(map);
    });
    map.on("moveend", () => refreshOcclusion(map));
  }

  // Buildings hide what's behind them: "building" is the element type the
  // core knows them by, whatever the domain.
  setOcclusionInputs(
    map,
    anchor,
    elements.filter((e) => e.type === "building"),
    Object.fromEntries(
      [...sources].filter(([, { occludable }]) => occludable).map(([id, { types }]) => [id, elementsOf(types)])
    )
  );
}

/** Shows/clears a highlight outline around a single intervention's geometry
 * (used when a placed-intervention card is selected from the list) — one
 * source with fill/line/circle layers so it works for any placement type. */
export function setHighlight(map: MapLibreMap, geometry: GeoJSON.Geometry | null): void {
  setOrCreateSource(map, "highlight", featureCollection(
    geometry ? [{ type: "Feature", geometry, properties: {} }] : []
  ));
}

/** Shows the placed camera's position and field of view on the map, so the
 * plan view and the 3D panel visibly refer to the same viewpoint. Pass null to
 * clear. `wedge` is the sector from `three/camera.ts`; `position` is the apex,
 * drawn separately so the camera itself stays visible when the wedge is
 * hidden under buildings. */
export function setCameraView(
  map: MapLibreMap,
  view: { wedge: GeoJSON.Polygon; position: [number, number] } | null
): void {
  setOrCreateSource(map, "camera", featureCollection(
    view
      ? [
          { type: "Feature", geometry: view.wedge, properties: { part: "wedge" } },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: view.position },
            properties: { part: "position" },
          },
        ]
      : []
  ));
}

/** `promoteId` matters for any source `refreshOcclusion` (see `occlusion.ts`)
 * calls `setFeatureState` on: GeoJSON sources are tiled internally via
 * `geojson-vt`, whose vector-tile-spec feature ids are integer-only — a
 * `Feature.id` that isn't a plain number (ours are strings like `"tree-0"`)
 * gets silently replaced with an auto-generated per-tile sequence, so
 * `setFeatureState` calls keyed on our real id would write state nothing
 * ever reads. `promoteId` points MapLibre at a `properties` field to use as
 * the feature id instead, sidestepping that entirely — every element
 * feature already carries `elementId` (see `elementsToFeatures`), so that's
 * what every marker source below uses. */
function setOrCreateSource(
  map: MapLibreMap,
  id: string,
  data: GeoJSON.FeatureCollection,
  promoteId?: string
): void {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
  } else {
    map.addSource(id, { type: "geojson", data, ...(promoteId ? { promoteId } : {}) });
  }
}

// `line-width` is a *pixel* value, constant across zoom unless wrapped in a
// zoom expression — a flat `k * width_m` (the old formula here) only reads
// as the right real-world width at whatever zoom it was tuned for. Zoom in,
// and the projected distance between two real, correctly-separated features
// (e.g. a bridged divided-road pair — see ingestion/osm.py's street_widths)
// grows while the fixed-pixel line doesn't, so a gap that looked closed at
// the default zoom reopens. `metersToPixelsAtZoom`/`realWidthLineWidth`
// convert a real metre width into pixels that track Web Mercator's 2^zoom
// scaling exactly at every zoom, not just one — the standard idiom for a
// "real-world-sized" line/circle in MapLibre/Mapbox styles: two reference
// zooms (0 and 22) bracket the whole usable range, and `interpolate
// exponential 2` reconstructs the exact in-between (and beyond) values
// because the underlying relationship *is* exponential in zoom.
const EARTH_CIRCUMFERENCE_PX_AT_Z0 = 156543.03392;

function metersToPixelsAtZoom(zoom: number, latDeg: number): number {
  return 2 ** zoom / (EARTH_CIRCUMFERENCE_PX_AT_Z0 * Math.cos((latDeg * Math.PI) / 180));
}

// Same visual exaggeration the old flat formula applied (`* 3`) — real
// lines read as too thin to notice on a flat top-down map at true scale.
const LINE_WIDTH_EXAGGERATION = 3;

// Thin lines (e.g. 0.12m lane lines) come out well under a pixel at true
// scale on the default view, i.e. invisible. `minPx` floors the width; it's
// applied per stop, so stops are every 2 zoom levels — between two unclamped
// stops the exponential interpolation is still exact, only near the clamp
// does it approximate.
function realWidthLineWidth(
  defaultWidthM: number,
  latDeg: number,
  exaggeration: number = LINE_WIDTH_EXAGGERATION,
  minPx = 0
): ExpressionSpecification {
  const widthM = ["*", exaggeration, ["coalesce", ["get", "width"], defaultWidthM]];
  const stops: unknown[] = [];
  for (let zoom = 0; zoom <= 22; zoom += 2) {
    stops.push(zoom, ["max", minPx, ["*", widthM, metersToPixelsAtZoom(zoom, latDeg)]]);
  }
  return ["interpolate", ["exponential", 2], ["zoom"], ...stops] as unknown as ExpressionSpecification;
}

function ensureLayers(map: MapLibreMap, latDeg: number, showBoundary: boolean, layers: MapElementLayer[]): void {
  if (map.getLayer("covers-fill")) return; // already built, sources were just refreshed above

  // One raster icon per card type, registered once — see cardMarkerIcons.ts.
  // Plain white so a single image reads against any category color, rather
  // than pre-rendering a tinted variant per category.
  const pack = activePack();
  for (const cardType of Object.keys(pack.cardIcons)) {
    if (!map.hasImage(cardType)) {
      map.addImage(cardType, buildCardMarkerImage(cardType));
    }
  }

  map.addLayer({
    id: "covers-fill",
    type: "fill",
    source: "covers",
    paint: {
      "fill-color": [
        "match",
        ["get", "cover_type"],
        ...Object.entries(pack.coverTypes).flatMap(([type, cover]) => [type, cover.color]),
        "#c9c6bd",
      ] as unknown as ExpressionSpecification,
    },
  });

  const helpers: MapLayerHelpers = {
    realWidth: (defaultWidthM, exaggeration = LINE_WIDTH_EXAGGERATION, minPx = 0) =>
      realWidthLineWidth(defaultWidthM, latDeg, exaggeration, minPx),
    lineWidthExaggeration: LINE_WIDTH_EXAGGERATION,
    dimIfOccluded,
  };
  for (const layer of layers) {
    map.addLayer({ ...layer.style(helpers), id: layer.id, source: layer.source } as LayerSpecification);
  }

  // Rendered as small card-shaped rectangles (see `cardShapePolygon`), not
  // circles — the point is to look like a physical card placed on the map.
  // A soft offset shadow underneath (see `cardShadowPolygon`) sells the
  // "lifted paper card" read; the icon on top (see `cardMarkerIcons.ts`)
  // identifies *which* card, not just its category color.
  map.addLayer({
    id: "intervention-marker-shadows-fill",
    type: "fill",
    source: "intervention-marker-shadows",
    paint: { "fill-color": "#000", "fill-opacity": 0.22 },
  });
  map.addLayer({
    id: "intervention-markers-fill",
    type: "fill",
    source: "intervention-markers",
    paint: {
      "fill-color": [
        "match",
        ["get", "category"],
        ...pack.cardCategories.flatMap((category) => [category.id, category.color]),
        "#999",
      ] as unknown as ExpressionSpecification,
      "fill-opacity": 0.92,
    },
  });
  map.addLayer({
    id: "intervention-markers-line",
    type: "line",
    source: "intervention-markers",
    paint: { "line-color": "#fff", "line-width": 1.5 },
  });
  map.addLayer({
    id: "intervention-markers-icon",
    type: "symbol",
    source: "intervention-markers",
    layout: {
      "icon-image": ["get", "cardType"],
      "icon-size": 0.5,
      "icon-rotate": ["get", "rotationDeg"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });

  // `site_boundary` source only exists for a surveyed site (see renderScene) —
  // a provisional placeholder (e.g. Bologna's circle) has no source to draw.
  if (showBoundary) {
    map.addLayer({
      id: "site-boundary-line",
      type: "line",
      source: "site_boundary",
      paint: { "line-color": "#333", "line-width": 2, "line-dasharray": [2, 2] },
    });
  }

  map.addLayer({
    id: "highlight-fill",
    type: "fill",
    source: "highlight",
    // Areas only: MapLibre would otherwise fill a path as if it were closed.
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": "#ffcc00", "fill-opacity": 0.3 },
  });
  map.addLayer({
    id: "highlight-line",
    type: "line",
    source: "highlight",
    paint: { "line-color": "#ff9900", "line-width": 4 },
  });
  map.addLayer({
    id: "highlight-circle",
    type: "circle",
    source: "highlight",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 14,
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": "#ff9900",
      "circle-stroke-width": 4,
    },
  });

  // Blue, deliberately unlike the yellow/orange intervention highlight and the
  // green vegetation: the camera is a view aid, not part of the proposal.
  map.addLayer({
    id: "camera-wedge-fill",
    type: "fill",
    source: "camera",
    filter: ["==", ["get", "part"], "wedge"],
    paint: { "fill-color": "#2f7fd6", "fill-opacity": 0.18 },
  });
  map.addLayer({
    id: "camera-wedge-line",
    type: "line",
    source: "camera",
    filter: ["==", ["get", "part"], "wedge"],
    paint: { "line-color": "#2f7fd6", "line-width": 1.5, "line-opacity": 0.8 },
  });
  map.addLayer({
    id: "camera-position",
    type: "circle",
    source: "camera",
    filter: ["==", ["get", "part"], "position"],
    paint: {
      "circle-radius": 6,
      "circle-color": "#2f7fd6",
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 2,
    },
  });
}
