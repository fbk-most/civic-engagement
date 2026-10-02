import type { CardSpec } from "../api/types";

// Display-only Italian labels for internal codes. The codes themselves
// (species/material/cover_type values) stay in English since the backend
// uses them as lookup keys (growth tables, cost tables, etc.) — only what's
// shown to the facilitator is translated here.

export const SPECIES_LABELS_IT: Record<string, string> = {
  oak: "Quercia",
  birch: "Betulla",
  linden: "Tiglio",
  plane: "Platano",
  elm: "Olmo",
  ginkgo: "Ginkgo",
  horse_chestnut: "Ippocastano",
  cypress: "Cipresso",
  pine: "Pino",
  unknown: "Sconosciuta",
};

export const MATERIAL_LABELS_IT: Record<string, string> = {
  paving: "Pavimentazione",
  gravel: "Ghiaia",
  permeable_paving: "Pavimentazione permeabile",
  wood: "Legno",
};

export const COVER_TYPE_LABELS_IT: Record<string, string> = {
  paving: "Pavimentazione",
  gravel: "Ghiaia",
  permeable_paving: "Pavimentazione permeabile",
  lawn: "Prato",
  meadow: "Prato fiorito",
  wood: "Bosco",
  water: "Acqua",
  playground_surface: "Pavimentazione area giochi",
  sport_surface: "Pavimentazione sportiva",
};

export const CARD_CATEGORY_LABELS_IT: Record<string, string> = {
  vegetazione: "Vegetazione",
  copertura_suolo: "Copertura del suolo",
  elementi_architettonici: "Elementi architettonici",
  sociale: "Sociale",
};

export const PERGOLA_SIZE_LABELS_IT: Record<string, string> = {
  small: "Piccola",
  medium: "Media",
  large: "Grande",
};

export const AGE_RANGE_LABELS_IT: Record<string, string> = {
  junior: "Bambini",
  mixed: "Tutte le età",
};

export const TARGET_AGE_LABELS_IT: Record<string, string> = {
  teens: "Ragazzi",
  mixed: "Tutte le età",
};

const OPTION_LABEL_MAPS: Record<string, Record<string, string>> = {
  species: SPECIES_LABELS_IT,
  material: MATERIAL_LABELS_IT,
  cover_type: COVER_TYPE_LABELS_IT,
  size: PERGOLA_SIZE_LABELS_IT,
  age_range: AGE_RANGE_LABELS_IT,
  target_age: TARGET_AGE_LABELS_IT,
};

export function optionLabel(paramKey: string, value: string): string {
  return OPTION_LABEL_MAPS[paramKey]?.[value] ?? value;
}

/** "Ora" / "+Na" — shared by the time slider and anywhere an intervention's
 * `planted_year` needs to be shown, so the two stay in the same vocabulary. */
export function yearLabel(t: number): string {
  return t === 0 ? "Ora" : `+${t}a`;
}

export const AGE_CLASS_LABELS_IT: Record<string, string> = {
  sapling: "Plantina",
  young: "Giovane",
  mature: "Maturo",
  veteran: "Veterano",
};

/** One-line "Label: value · Label: value" summary of an intervention's
 * parameters, for the intervention list and the 3D info card. */
export function summarizeParams(card: CardSpec | undefined, params: Record<string, unknown>): string {
  if (!card) return "";
  return card.params
    .map((p) => `${p.label}: ${optionLabel(p.key, String(params[p.key] ?? p.default))}`)
    .join(" · ");
}
