import type { FrontendPack, Pair } from "civic-engagement";

// The rural pack's side of the frontend (see the core's src/pack.ts): the
// two cards (plant, fell), the land covers (from OpenStreetMap; the forest
// as stands, see the backend's stands.py) and the covers the cards become.
// Where there is no cover, the ground is the terrain's own surface.

const FOREST_GREEN = "#2e6b1f";

const SPECIES: Record<string, Pair> = {
  spruce: ["Abete rosso", "Norway spruce"],
  larch: ["Larice", "Larch"],
  beech: ["Faggio", "Beech"],
  mixed: ["Misto", "Mixed"],
};

// In the space use chart's stacking order.
const COVER_TYPES: FrontendPack["coverTypes"] = {
  forest: { label: ["Bosco", "Forest"], color: "#3f7a35" },
  planting: { label: ["Rimboschimento", "Planting"], color: "#6fae57" },
  felling: { label: ["Taglio", "Felling"], color: "#b08a5a" },
  scrub: { label: ["Arbusteto", "Scrub"], color: "#8a9a4e" },
  meadow: { label: ["Prato", "Meadow"], color: "#b9cc7a" },
  grassland: { label: ["Pascolo", "Grassland"], color: "#cdd59a" },
  rock: { label: ["Roccia", "Rock"], color: "#a8a49c" },
  residential: { label: ["Abitato", "Village"], color: "#c9b8a6" },
};

export const ruralPack: FrontendPack = {
  id: "rural",
  title: "Rural Digital Twin",
  features: { thermal: false, life: false },
  cardCategories: [{ id: "bosco", label: ["Bosco", "Forest"], color: FOREST_GREEN }],
  cardIcons: {
    // Three young trees.
    plant_forest: [
      { kind: "line", x1: 6, y1: 21, x2: 6, y2: 15 },
      { kind: "path", d: "M2.5 16L6 8l3.5 8z" },
      { kind: "line", x1: 12, y1: 21, x2: 12, y2: 13 },
      { kind: "path", d: "M8 14l4-10 4 10z" },
      { kind: "line", x1: 18, y1: 21, x2: 18, y2: 15 },
      { kind: "path", d: "M14.5 16L18 8l3.5 8z" },
    ],
    // A stump, with an axe.
    fell_forest: [
      { kind: "rect", x: 3, y: 14, w: 10, h: 7, rx: 1 },
      { kind: "path", d: "M5.5 17.5h5" },
      { kind: "line", x1: 14, y1: 3, x2: 21, y2: 14 },
      { kind: "path", d: "M13 3.5l4-1.5 1.5 3.5-4 1z" },
    ],
  },
  coverTypes: COVER_TYPES,
  labels: {
    options: { species: SPECIES },
    species: SPECIES,
    ageClasses: {},
  },
  map: { layers: [], legend: [] },
  scene3d: {
    // Ground colours: the stands' trees will stand on the forest floor.
    coverSurfaces: {
      forest: { color: 0x6f7f4a, roughness: 1, texture: "lawn" },
      planting: { color: 0x9cc27e, roughness: 0.95, texture: "lawn" },
      felling: { color: 0xb59a76, roughness: 1, texture: "gravel" },
      scrub: { color: 0x98a463, roughness: 1, texture: "lawn" },
      meadow: { color: 0xc4d38e, roughness: 0.95, texture: "lawn" },
      grassland: { color: 0xd0d6a0, roughness: 0.95, texture: "lawn" },
      rock: { color: 0xb0aca4, roughness: 1, texture: "gravel" },
      residential: { color: 0xc8beb2, roughness: 0.9, texture: "paving" },
    },
    pathSurfaces: {},
    ribbonTypes: [],
    waterCoverTypes: [],
    parts: [],
    // Mountain meadow, until the stands and the land cover come.
    terrainSurface: { color: 0xa3b77f, roughness: 1, texture: "lawn" },
  },
};
