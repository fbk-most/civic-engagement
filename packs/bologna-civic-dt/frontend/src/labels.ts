import type { FrontendPack, Pair } from "civic-engagement";

// Italian and English names, and colours, of the urban domain's codes (see
// the core's i18n/labels.ts and pack.ts).

const SPECIES: Record<string, Pair> = {
  oak: ["Quercia", "Oak"],
  birch: ["Betulla", "Birch"],
  linden: ["Tiglio", "Linden"],
  plane: ["Platano", "Plane"],
  elm: ["Olmo", "Elm"],
  ginkgo: ["Ginkgo", "Ginkgo"],
  horse_chestnut: ["Ippocastano", "Horse chestnut"],
  cypress: ["Cipresso", "Cypress"],
  pine: ["Pino", "Pine"],
  unknown: ["Sconosciuta", "Unknown"],
};

const MATERIALS: Record<string, Pair> = {
  paving: ["Pavimentazione", "Paving"],
  gravel: ["Ghiaia", "Gravel"],
  permeable_paving: ["Pavimentazione permeabile", "Permeable paving"],
  wood: ["Legno", "Wood"],
};

/** In the space use chart's stacking order. Also the colour key of that
 * chart, in the Indicators tab. */
export const COVER_TYPES: FrontendPack["coverTypes"] = {
  paving: { label: ["Pavimentazione", "Paving"], color: "#c9c6bd" },
  gravel: { label: ["Ghiaia", "Gravel"], color: "#bdb6a8" },
  permeable_paving: { label: ["Pavimentazione permeabile", "Permeable paving"], color: "#b7c2b0" },
  lawn: { label: ["Prato", "Lawn"], color: "#9bc27c" },
  meadow: { label: ["Prato fiorito", "Wildflower meadow"], color: "#c3cf6e" },
  wood: { label: ["Bosco", "Woodland"], color: "#4f7942" },
  water: { label: ["Acqua", "Water"], color: "#7fb3d5" },
  playground_surface: { label: ["Pavimentazione area giochi", "Playground surface"], color: "#e3a0b5" },
  sport_surface: { label: ["Pavimentazione sportiva", "Sports surface"], color: "#8fc4c4" },
};

/** In the card palette's order; the colours double as the category's visual
 * identity across the palette, the placed-intervention list, the map markers
 * and the 3D placards. */
export const CARD_CATEGORIES: FrontendPack["cardCategories"] = [
  { id: "vegetazione", label: ["Vegetazione", "Vegetation"], color: "#2e6b1f" },
  { id: "copertura_suolo", label: ["Copertura del suolo", "Ground cover"], color: "#8a6d3b" },
  { id: "elementi_architettonici", label: ["Elementi architettonici", "Built elements"], color: "#5b6472" },
  { id: "sociale", label: ["Sociale", "Social"], color: "#c9752f" },
];

const PERGOLA_SIZES: Record<string, Pair> = {
  small: ["Piccola", "Small"],
  medium: ["Media", "Medium"],
  large: ["Grande", "Large"],
};

const AGE_RANGES: Record<string, Pair> = {
  junior: ["Bambini", "Children"],
  mixed: ["Tutte le età", "All ages"],
};

const TARGET_AGES: Record<string, Pair> = {
  teens: ["Ragazzi", "Teenagers"],
  mixed: ["Tutte le età", "All ages"],
};

const AGE_CLASSES: Record<string, Pair> = {
  sapling: ["Plantina", "Sapling"],
  young: ["Giovane", "Young"],
  mature: ["Maturo", "Mature"],
  veteran: ["Veterano", "Veteran"],
};

export const LABELS: FrontendPack["labels"] = {
  options: {
    species: SPECIES,
    material: MATERIALS,
    cover_type: Object.fromEntries(Object.entries(COVER_TYPES).map(([code, cover]) => [code, cover.label])),
    size: PERGOLA_SIZES,
    age_range: AGE_RANGES,
    target_age: TARGET_AGES,
  },
  species: SPECIES,
  ageClasses: AGE_CLASSES,
};
