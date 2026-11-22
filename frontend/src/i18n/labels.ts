import type { CardSpec, ParamSpec, Uncontrollables, UncontrollableSpec } from "../api/types";
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

/** An uncontrollable's name, from the backend's catalog. */
export function uncontrollableLabel(spec: UncontrollableSpec): string {
  return tr(spec.label, spec.label_en);
}

/** The name of one of its values (`value` missing: its default's). */
export function uncontrollableValueLabel(spec: UncontrollableSpec, value: string | undefined): string {
  const found = spec.values.find((v) => v.id === (value ?? spec.default));
  return found ? tr(found.label, found.label_en) : (value ?? "");
}

/** "Riscaldamento: rapido · Mercato: stabile": the values in one line, for
 * where there's no room for their panel. */
export function uncontrollablesSummary(specs: UncontrollableSpec[], values: Uncontrollables): string {
  return specs.map((spec) => `${uncontrollableLabel(spec)}: ${uncontrollableValueLabel(spec, values[spec.id])}`).join(" · ");
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

/** Who placed a card, and who last changed it ("Posata da Anna · modificata
 * da Marco"); "" without teams, where cards have no authors. */
export function authorsLabel(authors: { created_by?: string | null; updated_by?: string | null }): string {
  const parts = [];
  if (authors.created_by) parts.push(tr(`Posata da ${authors.created_by}`, `Placed by ${authors.created_by}`));
  if (authors.updated_by && authors.updated_by !== authors.created_by) {
    parts.push(tr(`modificata da ${authors.updated_by}`, `changed by ${authors.updated_by}`));
  }
  return parts.join(" · ");
}

/** One-line "Label: value · Label: value" summary of an intervention's
 * parameters, for the intervention list and the 3D info card. */
export function summarizeParams(card: CardSpec | undefined, params: Record<string, unknown>): string {
  if (!card) return "";
  return card.params
    .map((p) => `${paramLabel(p)}: ${optionLabel(p.key, String(params[p.key] ?? p.default))}`)
    .join(" · ");
}
