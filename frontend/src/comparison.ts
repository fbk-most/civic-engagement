import type { ScenarioInfo } from "./api/types";

/** Comparing two scenarios (the `compare` panel): each side, A and B, is the
 * team's current scene (null) or one of its saved scenarios or the site's
 * presets (its id), looked at without loading it (`scenario=` on the
 * backend's routes). Pure functions, so that they can be tested
 * (comparison.test.ts). */

export type Side = "a" | "b";

/** Each side's source: null the current scene, else a scenario's id. */
export type Compared = Record<Side, string | null>;

export const SIDES: Side[] = ["a", "b"];

/** A side as the views showing it take it: where its scene and series come
 * from (null, the current scene; else a scenario's id), what it's called,
 * and a key that changes when what it shows does (`sourceKey`). */
export interface ComparedSource {
  scenario: string | null;
  label: string;
  key: string;
}

/** What a side is called: the scenario's name, or `current`'s. */
export function sourceLabel(source: string | null, scenarios: readonly ScenarioInfo[], current: string): string {
  if (source === null) return current;
  return scenarios.find((scenario) => scenario.id === source)?.name ?? source;
}

/** Changes whenever what a side shows does: the current scene's cards
 * (`cardsKey`, the ones turned on), or the scenario saved again. */
export function sourceKey(source: string | null, scenarios: readonly ScenarioInfo[], cardsKey: string): string {
  if (source === null) return `current:${cardsKey}`;
  return `scenario:${source}:${scenarios.find((scenario) => scenario.id === source)?.saved_at ?? ""}`;
}

/** The comparison at first: the current scene against the scenario saved
 * last (or the first preset), or against itself with none. */
export function initialCompared(scenarios: readonly ScenarioInfo[]): Compared {
  const saved = scenarios.find((scenario) => !scenario.preset) ?? scenarios[0];
  return { a: null, b: saved?.id ?? null };
}

/** The comparison once the scenarios are read again: a side whose
 * scenario is gone (deleted, in another window) back to the current scene. */
export function keptCompared(compared: Compared, scenarios: readonly ScenarioInfo[]): Compared {
  const kept = (source: string | null) => (source !== null && scenarios.some((s) => s.id === source) ? source : null);
  const next = { a: kept(compared.a), b: kept(compared.b) };
  return next.a === compared.a && next.b === compared.b ? compared : next;
}
