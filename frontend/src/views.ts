import type { InterventionDisplayMode, Operation, Panel, ViewSpec } from "./api/types";

/** Views (civic_engagement/views.py): what a screen shows, picked by the
 * URL. The container site that frames the app sets `#view=<id>`: a change
 * of the fragment is applied at once, without reloading (App.tsx listens
 * to `hashchange`); `?view=<id>` works too, the fragment winning. A view
 * only hides: changing something is the role's and the phase's (`can`).
 * Pure functions, so that they can be tested (views.test.ts). */

export type Tab = ViewSpec["tab"];

const TABS: Tab[] = ["2d", "3d", "indicators"];

// The panels that are controls for a change, with the operation it needs.
const NEEDS: Partial<Record<Panel, Operation>> = { cards: "interventions.edit", scenarios: "scenarios.edit" };

/** The view asked for in the URL: `view=<id>` in the fragment, else in
 * the query; null in neither. */
export function requestedView(search: string, hash: string): string | null {
  const param = (query: string) => new URLSearchParams(query).get("view") || null;
  return param(hash.replace(/^#/, "")) ?? param(search);
}

/** The view a screen shows: the one asked for in the URL if it's one of
 * the phase's, else the phase's default (its first). `phaseViews`, the
 * phase's (`Me.views`); null without a phase, when any of the pack's may
 * be asked for and there's no default. Null, everything shown: no views,
 * or a phase without any. */
export function resolveView(
  search: string,
  hash: string,
  phaseViews: string[] | null,
  available: ViewSpec[]
): ViewSpec | null {
  const byId = (id: string | undefined) => available.find((view) => view.id === id) ?? null;
  const requested = requestedView(search, hash);
  const allowed = phaseViews ?? available.map((view) => view.id);
  if (requested !== null && allowed.includes(requested) && byId(requested)) return byId(requested);
  return phaseViews ? byId(phaseViews[0]) : null;
}

/** Whether a panel is shown: the view has it (no view: all), and, for
 * the controls of a change, this member may do it now. */
export function panelShown(view: ViewSpec | null, panel: Panel, operations: readonly Operation[]): boolean {
  const needed = NEEDS[panel];
  return (view === null || view.panels.includes(panel)) && (needed === undefined || operations.includes(needed));
}

/** The tabs a view offers: all without a view. */
export function viewTabs(view: ViewSpec | null): Tab[] {
  return TABS.filter((tab) => view === null || view.panels.includes(`tab.${tab}`));
}

/** The interventions' display: the one chosen, unless the view hasn't the
 * switch and says which. */
export function viewInterventionMode(view: ViewSpec | null, chosen: InterventionDisplayMode): InterventionDisplayMode {
  return view === null || view.panels.includes("interventionMode") ? chosen : view.intervention_mode;
}

/** The tab after a change of view, from `previous` (null: none) to `next`:
 * the one it opens on if it differs from the previous view's, or if the
 * tab shown isn't one it offers; else the tab shown, kept. */
export function tabAfter(previous: ViewSpec | null, next: ViewSpec | null, current: Tab): Tab {
  if (next === null) return current;
  if (!viewTabs(next).includes(current) || previous?.tab !== next.tab) return next.tab;
  return current;
}
