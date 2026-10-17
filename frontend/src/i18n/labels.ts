import type { CardSpec, ParamSpec } from "../api/types";
import { tr } from "./lang";

// Display labels, Italian and English, for internal codes. The codes
// themselves (species/material/cover_type values) stay in English since the
// backend uses them as lookup keys (growth tables, cost tables, etc.) — only
// what's shown to the facilitator is translated here.

type Pair = [it: string, en: string];

function pick(labels: Record<string, Pair>, code: string): string {
  const pair = labels[code];
  return pair ? tr(...pair) : code;
}

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

const COVER_TYPES: Record<string, Pair> = {
  paving: ["Pavimentazione", "Paving"],
  gravel: ["Ghiaia", "Gravel"],
  permeable_paving: ["Pavimentazione permeabile", "Permeable paving"],
  lawn: ["Prato", "Lawn"],
  meadow: ["Prato fiorito", "Wildflower meadow"],
  wood: ["Bosco", "Woodland"],
  water: ["Acqua", "Water"],
  playground_surface: ["Pavimentazione area giochi", "Playground surface"],
  sport_surface: ["Pavimentazione sportiva", "Sports surface"],
};

const CARD_CATEGORIES: Record<string, Pair> = {
  vegetazione: ["Vegetazione", "Vegetation"],
  copertura_suolo: ["Copertura del suolo", "Ground cover"],
  elementi_architettonici: ["Elementi architettonici", "Built elements"],
  sociale: ["Sociale", "Social"],
};

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

const OPTION_LABEL_MAPS: Record<string, Record<string, Pair>> = {
  species: SPECIES,
  material: MATERIALS,
  cover_type: COVER_TYPES,
  size: PERGOLA_SIZES,
  age_range: AGE_RANGES,
  target_age: TARGET_AGES,
};

export function speciesLabel(code: string): string {
  return pick(SPECIES, code);
}

export function coverTypeLabel(code: string): string {
  return pick(COVER_TYPES, code);
}

export function cardCategoryLabel(code: string): string {
  return pick(CARD_CATEGORIES, code);
}

export function ageClassLabel(code: string): string {
  return pick(AGE_CLASSES, code);
}

export function optionLabel(paramKey: string, value: string): string {
  const labels = OPTION_LABEL_MAPS[paramKey];
  return labels ? pick(labels, value) : value;
}

/** A card's name, from the backend's catalog (GET /api/cards). */
export function cardLabel(card: CardSpec): string {
  return tr(card.label, card.label_en);
}

/** A card parameter's name, from the backend's catalog. */
export function paramLabel(param: ParamSpec): string {
  return tr(param.label, param.label_en);
}

/** "Ora" / "+Na" ("Now" / "+Ny") — shared by the time slider and anywhere
 * an intervention's `planted_year` needs to be shown, so the two stay in the
 * same vocabulary. */
export function yearLabel(t: number): string {
  return t === 0 ? tr("Ora", "Now") : tr(`+${t}a`, `+${t}y`);
}

/** One-line "Label: value · Label: value" summary of an intervention's
 * parameters, for the intervention list and the 3D info card. */
export function summarizeParams(card: CardSpec | undefined, params: Record<string, unknown>): string {
  if (!card) return "";
  return card.params
    .map((p) => `${paramLabel(p)}: ${optionLabel(p.key, String(params[p.key] ?? p.default))}`)
    .join(" · ");
}
