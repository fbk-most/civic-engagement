import {
  GeoJSONSource,
  type MapLibreMap,
  type LngLatBoundsLike,
  type ExpressionSpecification,
} from "maplibre-gl";
import type { CardSpec, DiscreteElement, InterventionDisplayMode, SceneResponse } from "../api/types";
import { CATEGORY_COLORS } from "../ui/categoryColors";
import { anchorFromPolygon, representativePoint, toLocal, toLngLat, type GeoAnchor } from "../three/geo";
import { hashString } from "../three/hash";
import { ALL_CARD_TYPES, buildCardMarkerImage } from "./cardMarkerIcons";
import { OCCLUDED_OPACITY, refreshOcclusion, setOcclusionInputs } from "./occlusion";

// How often occlusion re-evaluates while the camera is actively being
// dragged (see the `move` listener in `renderScene`) — frequent enough to
// read as live, not so frequent that a long drag/rotate is doing real work
// (`markers x buildings`) every single animation frame for no visible gain.
const OCCLUSION_MOVE_REFRESH_MS = 150;

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

/** Also the colour key of the "Uso dello spazio" chart in the Indicatori tab. */
export const COVER_COLORS: Record<string, string> = {
  paving: "#c9c6bd",
  gravel: "#bdb6a8",
  permeable_paving: "#b7c2b0",
  lawn: "#9bc27c",
  meadow: "#c3cf6e",
  wood: "#4f7942",
  water: "#7fb3d5",
  playground_surface: "#e3a0b5",
  sport_surface: "#8fc4c4",
};

// Must stay in sync with `ui/MapLegend.tsx`'s swatch colors.
const SOCIAL_ELEMENT_COLORS: Record<string, string> = {
  streetlight: "#e8b93d",
  pergola: "#9c6b3e",
  kiosk: "#b5482f",
  playground: "#d94f70",
  fitness_area: "#3f8f8f",
  traffic_signal: "#c0392b",
};

// Flat, class-agnostic for now — see the plan's "explicitly out of scope"
// note on road-class-based street styling.
const STREET_COLOR = "#4a4a4a";

const PATH_COLORS: Record<string, string> = {
  paving: "#9a9186",
  gravel: "#a89f8f",
  wood: "#8a6d3b",
  permeable_paving: "#a3ab97",
};

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
  const byType = (type: string) => elementsToFeatures(elements.filter((e) => e.type === type));
  const anchor = anchorFromPolygon(scene.site_boundary);

  setOrCreateSource(map, "covers", featureCollection(
    covers.map((c) => ({
      type: "Feature",
      id: c.id,
      geometry: c.geometry,
      properties: { cover_type: c.cover_type, source: c.source, interventionId: c.intervention_id },
    }))
  ));
  setOrCreateSource(map, "buildings", featureCollection(byType("building")));
  setOrCreateSource(map, "paths", featureCollection(byType("path")));
  setOrCreateSource(map, "streets", featureCollection(byType("street")));
  setOrCreateSource(map, "trees", featureCollection(byType("tree")), "elementId");
  setOrCreateSource(map, "benches", featureCollection(byType("bench")), "elementId");
  setOrCreateSource(map, "water_features", featureCollection(byType("water_feature")), "elementId");
  setOrCreateSource(map, "streetlights", featureCollection(byType("streetlight")), "elementId");
  setOrCreateSource(map, "pergolas", featureCollection(byType("pergola")), "elementId");
  setOrCreateSource(map, "kiosks", featureCollection(byType("kiosk")), "elementId");
  setOrCreateSource(map, "playgrounds", featureCollection(byType("playground")), "elementId");
  setOrCreateSource(map, "fitness_areas", featureCollection(byType("fitness_area")), "elementId");
  // No `promoteId`: unlike the other social-element sources, a flat road
  // marking isn't a plausible occlusion target (same precedent as paths and
  // streets), so nothing ever calls `setFeatureState` on these.
  setOrCreateSource(map, "crossings", featureCollection(byType("crossing")));
  setOrCreateSource(map, "lane_dividers", featureCollection(byType("lane_divider")));
  setOrCreateSource(map, "traffic_signals", featureCollection(byType("traffic_signal")), "elementId");
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
          category: card?.category ?? "elementi_architettonici",
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
  ensureLayers(map, anchor.lat0, scene.boundary_status === "surveyed");
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

  setOcclusionInputs(map, anchor, elements.filter((e) => e.type === "building"), {
    trees: elements.filter((e) => e.type === "tree"),
    benches: elements.filter((e) => e.type === "bench"),
    water_features: elements.filter((e) => e.type === "water_feature"),
    streetlights: elements.filter((e) => e.type === "streetlight"),
    pergolas: elements.filter((e) => e.type === "pergola"),
    kiosks: elements.filter((e) => e.type === "kiosk"),
    playgrounds: elements.filter((e) => e.type === "playground"),
    fitness_areas: elements.filter((e) => e.type === "fitness_area"),
    traffic_signals: elements.filter((e) => e.type === "traffic_signal"),
  });
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

// Streets specifically were reading as too thick at the default exaggeration
// (wide enough to visibly overlap building footprints) — scaled down to 80%
// of it. Still provably >1, which is what actually matters for the bridged
// divided-road pairs (see ingestion/osm.py's street_widths): each bridged
// way's real-metre width is already >= (gap + margin), so for any
// exaggeration factor k > 1, k * (widthA + widthB) > k * (2*gap) > 2*gap —
// the two ribbons keep overlapping regardless of k, only *how much* spare
// overlap they have shrinks. k <= 1 is the actual danger zone (it can erase
// that spare margin entirely for a wide, near-threshold gap), which is why
// this is a haircut off the exaggeration, not a fraction of the true width.
const STREET_LINE_WIDTH_EXAGGERATION = LINE_WIDTH_EXAGGERATION * 0.8;

// Road markings (0.12m lane lines) come out well under a pixel at true scale
// on the default view, i.e. invisible. `minPx` floors the width; it's
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

function ensureLayers(map: MapLibreMap, latDeg: number, showBoundary: boolean): void {
  if (map.getLayer("covers-fill")) return; // already built, sources were just refreshed above

  // One raster icon per card type, registered once — see cardMarkerIcons.ts.
  // Plain white so a single image reads against any category color, rather
  // than pre-rendering a tinted variant per category.
  for (const cardType of ALL_CARD_TYPES) {
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
        ...Object.entries(COVER_COLORS).flat(),
        "#c9c6bd",
      ] as unknown as ExpressionSpecification,
    },
  });

  map.addLayer({
    id: "streets-line",
    type: "line",
    source: "streets",
    paint: {
      "line-color": STREET_COLOR,
      "line-width": realWidthLineWidth(6, latDeg, STREET_LINE_WIDTH_EXAGGERATION),
    },
  });

  // Registered after streets-line, so these paint on top of the asphalt
  // rather than under it — flat white, the same read as `materials.ts`'s
  // `crossing_marking`/`lane_divider` 3D surfaces.
  map.addLayer({
    id: "crossings-line",
    type: "line",
    source: "crossings",
    paint: { "line-color": "#ffffff", "line-width": realWidthLineWidth(0.5, latDeg) },
  });
  map.addLayer({
    id: "lane-dividers-line",
    type: "line",
    source: "lane_dividers",
    paint: { "line-color": "#ffffff", "line-width": realWidthLineWidth(0.12, latDeg, LINE_WIDTH_EXAGGERATION, 1) },
  });

  map.addLayer({
    id: "paths-line",
    type: "line",
    source: "paths",
    paint: {
      "line-color": [
        "match",
        ["get", "material"],
        ...Object.entries(PATH_COLORS).flat(),
        "#9a9186",
      ] as unknown as ExpressionSpecification,
      "line-width": realWidthLineWidth(2, latDeg),
    },
  });

  map.addLayer({
    id: "buildings-extrusion",
    type: "fill-extrusion",
    source: "buildings",
    paint: {
      "fill-extrusion-color": "#9c9c9c",
      "fill-extrusion-height": ["coalesce", ["get", "height"], 10],
      "fill-extrusion-opacity": 0.9,
    },
  });

  map.addLayer({
    id: "trees-circle",
    type: "circle",
    source: "trees",
    paint: {
      // Stumps render as a larger pale ring (fill + brown outline) rather
      // than a small solid dot: it needs to read clearly as a distinct marker
      // (not a bench) and be an easy click target, not just a visual detail.
      "circle-color": ["case", ["==", ["get", "status"], "stump"], "#e4d7bf", "#2e6b1f"],
      "circle-opacity": dimIfOccluded(0.85),
      "circle-stroke-opacity": dimIfOccluded(1),
      "circle-stroke-color": "#7a4a24",
      "circle-stroke-width": ["case", ["==", ["get", "status"], "stump"], 2, 0],
      // `zoom` may only be used as the top-level interpolate input (not nested
      // inside a `case`), so the stump/alive branch has to live in each stop's
      // output value instead of wrapping the whole expression. Stumps use the
      // same size formula as a live tree, fixed at a 6m canopy diameter — big
      // enough to click comfortably without exaggerating what's actually a
      // felled trunk into looking like a full tree.
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        15,
        3,
        20,
        ["case", ["==", ["get", "status"], "stump"], 2 * 6, ["*", 2, ["coalesce", ["get", "canopy_diameter"], 4]]],
      ],
    },
  });

  map.addLayer({
    id: "benches-circle",
    type: "circle",
    source: "benches",
    // Deliberately not brown/tan: that reads as a stump or a tree trunk at a
    // glance. Slate gray keeps it identifiable as street furniture instead.
    paint: { "circle-color": "#6b7280", "circle-radius": 2.5, "circle-opacity": dimIfOccluded(1) },
  });

  map.addLayer({
    id: "water-features-circle",
    type: "circle",
    source: "water_features",
    paint: { "circle-color": "#2f7fb3", "circle-radius": 5, "circle-opacity": dimIfOccluded(1) },
  });

  map.addLayer({
    id: "streetlights-circle",
    type: "circle",
    source: "streetlights",
    paint: { "circle-color": SOCIAL_ELEMENT_COLORS.streetlight, "circle-radius": 3, "circle-opacity": dimIfOccluded(1) },
  });
  map.addLayer({
    id: "pergolas-circle",
    type: "circle",
    source: "pergolas",
    paint: { "circle-color": SOCIAL_ELEMENT_COLORS.pergola, "circle-radius": 5, "circle-opacity": dimIfOccluded(1) },
  });
  map.addLayer({
    id: "kiosks-circle",
    type: "circle",
    source: "kiosks",
    paint: { "circle-color": SOCIAL_ELEMENT_COLORS.kiosk, "circle-radius": 6, "circle-opacity": dimIfOccluded(1) },
  });
  map.addLayer({
    id: "playgrounds-circle",
    type: "circle",
    source: "playgrounds",
    paint: { "circle-color": SOCIAL_ELEMENT_COLORS.playground, "circle-radius": 6, "circle-opacity": dimIfOccluded(1) },
  });
  map.addLayer({
    id: "fitness-areas-circle",
    type: "circle",
    source: "fitness_areas",
    paint: { "circle-color": SOCIAL_ELEMENT_COLORS.fitness_area, "circle-radius": 6, "circle-opacity": dimIfOccluded(1) },
  });
  map.addLayer({
    id: "traffic-signals-circle",
    type: "circle",
    source: "traffic_signals",
    paint: { "circle-color": SOCIAL_ELEMENT_COLORS.traffic_signal, "circle-radius": 3, "circle-opacity": dimIfOccluded(1) },
  });

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
        ...Object.entries(CATEGORY_COLORS).flat(),
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
