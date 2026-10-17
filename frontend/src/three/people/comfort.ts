/** How felt temperature shapes the crowd: who comes, where people stop,
 * and which way they walk. Both read the felt-temperature field (thermal/field.ts) through
 * a sampler, so this module knows curves, not grids.
 *
 * Anchored, like the field's colour scale, at UTCI's stress bands: nothing
 * changes within "no stress" (9-26 °C), and strong cold counts as much as
 * strong heat. Placeholder values, to revise with the team.
 */

import type { WalkNetwork } from "./network";

/** Felt temperature (°C) at a point of the local frame (x east, z south),
 * or null where the field says nothing (outside the grid, in buildings). */
export type FeltSampler = (x: number, z: number) => number | null;

type Curve = [celsius: number, value: number][];

// Willingness to stop at a spot: full in the comfort band, a few still do
// in strong heat or cold, almost nobody beyond. On the hot side, people
// put up with moderate heat (a summer morning in the sun, an afternoon in
// the shade) and leave quickly past UTCI's "strong heat stress" (32 °C):
// the step the climate assumption (CLIMATE_WARMING_C in the backend's
// parameters.py) takes a summer morning across.
const STAY: Curve = [
  [-27, 0.05],
  [-13, 0.15],
  [0, 0.6],
  [9, 1],
  [30, 1],
  [32, 0.75],
  [34, 0.3],
  [37, 0.1],
  [46, 0.05],
];

// Willingness to walk through at all. Milder than STAY: many trips across
// a square have to be made anyway (to work, to the shops), in any weather.
const PASS: Curve = [
  [-27, 0.3],
  [-13, 0.5],
  [0, 0.8],
  [9, 1],
  [26, 1],
  [32, 0.8],
  [38, 0.5],
  [46, 0.3],
];

// How much longer a stretch of path feels. Capped at 2: people take the
// shady (or sunny) street next to theirs, not a long detour.
const WALK_COST: Curve = [
  [-13, 2],
  [0, 1.4],
  [9, 1],
  [26, 1],
  [32, 1.4],
  [38, 2],
];

function along(curve: Curve, celsius: number): number {
  if (celsius <= curve[0][0]) return curve[0][1];
  for (let k = 1; k < curve.length; k++) {
    const [hiC, hiV] = curve[k];
    if (celsius <= hiC) {
      const [loC, loV] = curve[k - 1];
      return loV + ((hiV - loV) * (celsius - loC)) / (hiC - loC);
    }
  }
  return curve[curve.length - 1][1];
}

/** 0-1: how much of a spot's usual occupancy stays at this felt temperature. */
export function stayFactor(celsius: number | null): number {
  return celsius === null ? 1 : along(STAY, celsius);
}

/** 0-1: how many of the usual walkers still come through at this felt
 * temperature. */
export function passFactor(celsius: number | null): number {
  return celsius === null ? 1 : along(PASS, celsius);
}

// A fountain on a hot day: up to this many times its usual visitors, at
// 38 °C felt and above — water cools, and children play in it.
const FOUNTAIN_PULL_AT_HEAT = 3;

/** How many of its usual visitors a destination (see network.ts) gets at
 * this felt temperature: fewer where it's too hot or cold to stay, and
 * more at a fountain on a hot day. */
export function visitFactor(kind: string, celsius: number | null): number {
  if (celsius === null) return 1;
  if (kind === "water_feature" && celsius > 26) {
    return 1 + (FOUNTAIN_PULL_AT_HEAT - 1) * Math.min(1, (celsius - 26) / 12);
  }
  return along(STAY, celsius);
}

/** 1-2: how many times longer a metre of path feels at this felt temperature. */
export function walkCostFactor(celsius: number | null): number {
  return celsius === null ? 1 : along(WALK_COST, celsius);
}

// Same spacing the network samples lighting at.
const EDGE_SAMPLE_M = 4;

/** Per network edge (by `NetworkEdge.id`), the mean `walkCostFactor` along it. */
export function edgeWalkCosts(network: WalkNetwork, felt: FeltSampler): Float32Array {
  const costs = new Float32Array(network.edgeEnds.length);
  network.edgeEnds.forEach(([[ax, az], [bx, bz]], id) => {
    const samples = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / EDGE_SAMPLE_M) + 1);
    let sum = 0;
    for (let k = 0; k < samples; k++) {
      const f = k / (samples - 1);
      sum += walkCostFactor(felt(ax + (bx - ax) * f, az + (bz - az) * f));
    }
    costs[id] = sum / samples;
  });
  return costs;
}

/** The walking network against the felt temperature on the site (`felt`
 * null elsewhere), by length. */
export interface NetworkExposure {
  /** Metres of network in all, and on the site. */
  length: number;
  onSite: number;
  /** Metres on the site in thermal stress. */
  stressed: number;
  /** `passFactor` averaged over the network on the site: 1 with none. */
  pass: number;
}

export function networkExposure(network: WalkNetwork, felt: FeltSampler): NetworkExposure {
  let length = 0;
  let onSite = 0;
  let stressed = 0;
  let pass = 0;
  for (const [[ax, az], [bx, bz]] of network.edgeEnds) {
    const edge = Math.hypot(bx - ax, bz - az);
    length += edge;
    const samples = Math.max(2, Math.ceil(edge / EDGE_SAMPLE_M) + 1);
    for (let k = 0; k < samples; k++) {
      const f = (k + 0.5) / samples;
      const celsius = felt(ax + (bx - ax) * f, az + (bz - az) * f);
      if (celsius === null) continue;
      onSite += edge / samples;
      pass += (passFactor(celsius) * edge) / samples;
      if (inThermalStress(celsius)) stressed += edge / samples;
    }
  }
  return { length, onSite, stressed, pass: onSite > 0 ? pass / onSite : 1 };
}

// --- how the crowd fares ----------------------------------------------------------

// Thermal stress, for the figures: from "strong heat" up, from "moderate
// cold" down — the second UTCI band on each side (the first, "moderate heat"
// and "slight cold", is discomfort most people shrug off).
export const HEAT_STRESS_C = 32;
export const COLD_STRESS_C = 0;

export function inThermalStress(celsius: number): boolean {
  return celsius >= HEAT_STRESS_C || celsius < COLD_STRESS_C;
}

export interface GroupExposure {
  /** People counted: those on the field (the site), not the streets around. */
  people: number;
  /** Of them, in heat or cold stress. */
  heat: number;
  cold: number;
  /** Mean felt temperature where they are; null with nobody counted. */
  meanFelt: number | null;
}

/** Who the temperature keeps away. */
export interface StopShortfall {
  /** People expected to stop on the site in comfortable weather, and in
   * this one (see `StopTally` in plan.ts). */
  wouldStop: number;
  stop: number;
  /** 0-1: of the usual walkers, the share who still come through. */
  pass: number;
}

export interface CrowdExposure {
  stopping: GroupExposure;
  walking: GroupExposure;
  all: GroupExposure;
  /** Null when people ignore the temperature (`?comfort=off`). */
  shortfall: StopShortfall | null;
}

/** Felt temperature where each person is, summed up. `felt` must say null
 * off the field, so people beyond the site aren't counted. */
export function crowdExposure(
  people: Iterable<{ x: number; z: number; walking: boolean }>,
  felt: FeltSampler,
  shortfall: StopShortfall | null
): CrowdExposure {
  const empty = (): GroupExposure & { sum: number } => ({ people: 0, heat: 0, cold: 0, meanFelt: null, sum: 0 });
  const stopping = empty();
  const walking = empty();
  const all = empty();
  for (const person of people) {
    const celsius = felt(person.x, person.z);
    if (celsius === null) continue;
    for (const group of [person.walking ? walking : stopping, all]) {
      group.people++;
      group.sum += celsius;
      if (celsius >= HEAT_STRESS_C) group.heat++;
      else if (celsius < COLD_STRESS_C) group.cold++;
    }
  }
  const finish = ({ sum, ...group }: GroupExposure & { sum: number }): GroupExposure => ({
    ...group,
    meanFelt: group.people > 0 ? sum / group.people : null,
  });
  return { stopping: finish(stopping), walking: finish(walking), all: finish(all), shortfall };
}
