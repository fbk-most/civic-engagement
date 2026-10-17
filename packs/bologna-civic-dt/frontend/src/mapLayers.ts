import type { ExpressionSpecification, FrontendPack, MapElementLayer } from "civic-engagement";

// The urban elements on the 2D map (see the core's map/layers.ts), in
// drawing order, and the legend that names them.

// The legend's swatches use the same colours.
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

const TREE_COLOR = "#2e6b1f";
const STUMP_FILL = "#e4d7bf";
const STUMP_RING = "#7a4a24";
const BENCH_COLOR = "#6b7280";
const WATER_FEATURE_COLOR = "#2f7fb3";

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
const STREET_EXAGGERATION_SHARE = 0.8;

function socialPoint(id: string, source: string, type: string, radius: number, interaction?: "select"): MapElementLayer {
  return {
    id,
    source,
    types: [type],
    occludable: true,
    interaction,
    style: ({ dimIfOccluded }) => ({
      type: "circle",
      paint: { "circle-color": SOCIAL_ELEMENT_COLORS[type], "circle-radius": radius, "circle-opacity": dimIfOccluded(1) },
    }),
  };
}

const LAYERS: MapElementLayer[] = [
  {
    id: "streets-line",
    source: "streets",
    types: ["street"],
    style: ({ realWidth, lineWidthExaggeration }) => ({
      type: "line",
      paint: {
        "line-color": STREET_COLOR,
        "line-width": realWidth(6, lineWidthExaggeration * STREET_EXAGGERATION_SHARE),
      },
    }),
  },
  // After streets-line, so these paint on top of the asphalt rather than
  // under it — flat white, the same read as the 3D view's
  // `crossing_marking`/`lane_divider` surfaces (three/materials.ts).
  {
    id: "crossings-line",
    source: "crossings",
    types: ["crossing"],
    style: ({ realWidth }) => ({ type: "line", paint: { "line-color": "#ffffff", "line-width": realWidth(0.5) } }),
  },
  {
    id: "lane-dividers-line",
    source: "lane_dividers",
    types: ["lane_divider"],
    style: ({ realWidth, lineWidthExaggeration }) => ({
      type: "line",
      paint: { "line-color": "#ffffff", "line-width": realWidth(0.12, lineWidthExaggeration, 1) },
    }),
  },
  {
    id: "paths-line",
    source: "paths",
    types: ["path"],
    interaction: "select",
    style: ({ realWidth }) => ({
      type: "line",
      paint: {
        "line-color": [
          "match",
          ["get", "material"],
          ...Object.entries(PATH_COLORS).flat(),
          "#9a9186",
        ] as unknown as ExpressionSpecification,
        "line-width": realWidth(2),
      },
    }),
  },
  {
    // Also the layer the felt-temperature map goes below (map/thermalLayer.ts).
    id: "buildings-extrusion",
    source: "buildings",
    types: ["building"],
    style: () => ({
      type: "fill-extrusion",
      paint: {
        "fill-extrusion-color": "#9c9c9c",
        "fill-extrusion-height": ["coalesce", ["get", "height"], 10],
        "fill-extrusion-opacity": 0.9,
      },
    }),
  },
  {
    id: "trees-circle",
    source: "trees",
    types: ["tree"],
    occludable: true,
    interaction: "tree",
    style: ({ dimIfOccluded }) => ({
      type: "circle",
      paint: {
        // Stumps render as a larger pale ring (fill + brown outline) rather
        // than a small solid dot: it needs to read clearly as a distinct marker
        // (not a bench) and be an easy click target, not just a visual detail.
        "circle-color": ["case", ["==", ["get", "status"], "stump"], STUMP_FILL, TREE_COLOR],
        "circle-opacity": dimIfOccluded(0.85),
        "circle-stroke-opacity": dimIfOccluded(1),
        "circle-stroke-color": STUMP_RING,
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
    }),
  },
  {
    id: "benches-circle",
    source: "benches",
    types: ["bench"],
    occludable: true,
    interaction: "select",
    // Deliberately not brown/tan: that reads as a stump or a tree trunk at a
    // glance. Slate gray keeps it identifiable as street furniture instead.
    style: ({ dimIfOccluded }) => ({
      type: "circle",
      paint: { "circle-color": BENCH_COLOR, "circle-radius": 2.5, "circle-opacity": dimIfOccluded(1) },
    }),
  },
  {
    id: "water-features-circle",
    source: "water_features",
    types: ["water_feature"],
    occludable: true,
    style: ({ dimIfOccluded }) => ({
      type: "circle",
      paint: { "circle-color": WATER_FEATURE_COLOR, "circle-radius": 5, "circle-opacity": dimIfOccluded(1) },
    }),
  },
  socialPoint("streetlights-circle", "streetlights", "streetlight", 3, "select"),
  socialPoint("pergolas-circle", "pergolas", "pergola", 5, "select"),
  socialPoint("kiosks-circle", "kiosks", "kiosk", 6, "select"),
  socialPoint("playgrounds-circle", "playgrounds", "playground", 6, "select"),
  socialPoint("fitness-areas-circle", "fitness_areas", "fitness_area", 6, "select"),
  socialPoint("traffic-signals-circle", "traffic_signals", "traffic_signal", 3),
];

const dot = (background: string) => ({ background });

const LEGEND: FrontendPack["map"]["legend"] = [
  { label: ["Albero", "Tree"], swatch: dot(TREE_COLOR) },
  {
    label: ["Ceppo (abbattuto)", "Stump (felled)"],
    swatch: { background: STUMP_FILL, border: `2px solid ${STUMP_RING}`, width: 8, height: 8 },
  },
  { label: ["Panchina", "Bench"], swatch: dot(BENCH_COLOR) },
  { label: ["Fontana", "Fountain"], swatch: dot(WATER_FEATURE_COLOR) },
  { label: ["Illuminazione", "Lighting"], swatch: dot(SOCIAL_ELEMENT_COLORS.streetlight) },
  { label: ["Pergola", "Pergola"], swatch: dot(SOCIAL_ELEMENT_COLORS.pergola) },
  { label: ["Chiosco", "Kiosk"], swatch: dot(SOCIAL_ELEMENT_COLORS.kiosk) },
  { label: ["Area giochi", "Playground"], swatch: dot(SOCIAL_ELEMENT_COLORS.playground) },
  { label: ["Area fitness", "Fitness area"], swatch: dot(SOCIAL_ELEMENT_COLORS.fitness_area) },
  // The legend's own colour for crossings (they're white on the map).
  { label: ["Attraversamento pedonale", "Pedestrian crossing"], swatch: dot("#2f6690") },
  { label: ["Semaforo", "Traffic light"], swatch: dot(SOCIAL_ELEMENT_COLORS.traffic_signal) },
];

export const MAP: FrontendPack["map"] = { layers: LAYERS, legend: LEGEND };
