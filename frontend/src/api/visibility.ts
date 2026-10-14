import type { Source } from "./types";

/** Whether the scene is shown as the simulation (`simulated`: the proposed
 * interventions built in) or as the situation as it is (the other modes). The
 * one rule every view uses to pick what to draw, so they cannot disagree.
 *
 * - Simulated: everything, except what an intervention's clearing has taken
 *   away (`cleared_by`): that is still served, but no longer there.
 * - Otherwise: only the baseline, including what a clearing will take away,
 *   which is still standing in the situation as it is. */
export function visibleIn<T extends { source: Source; cleared_by: string | null }>(
  items: T[],
  simulated: boolean
): T[] {
  return simulated ? items.filter((item) => !item.cleared_by) : items.filter((item) => item.source === "baseline");
}
