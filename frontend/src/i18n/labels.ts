import type { CardSpec, ParamSpec } from "../api/types";
import { activePack, type Pair } from "../pack";
import { tr } from "./lang";

// Display labels, Italian and English, for internal codes. The codes
// themselves (species/material/cover_type values) stay in English since the
// backend uses them as lookup keys (growth tables, cost tables, etc.) — only
// what's shown to the facilitator is translated, with the pack's labels
// (`FrontendPack.labels`, `coverTypes`, `cardCategories`).

function pick(labels: Record<string, Pair> | undefined, code: string): string {
  const pair = labels?.[code];
  return pair ? tr(...pair) : code;
}

export function speciesLabel(code: string): string {
  return pick(activePack().labels.species, code);
}

export function coverTypeLabel(code: string): string {
  return pick(Object.fromEntries(Object.entries(activePack().coverTypes).map(([k, v]) => [k, v.label])), code);
}

export function cardCategoryLabel(code: string): string {
  return pick(Object.fromEntries(activePack().cardCategories.map((c) => [c.id, c.label])), code);
}

export function ageClassLabel(code: string): string {
  return pick(activePack().labels.ageClasses, code);
}

export function optionLabel(paramKey: string, value: string): string {
  return pick(activePack().labels.options[paramKey], value);
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
