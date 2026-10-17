/** Where people sit and stand in the 3D view — a pure function of the scene's
 * elements, the time of day and the felt temperature, so it's reproducible
 * (a shared "Copia URL vista" link shows the same crowd) and cheap to
 * recompute.
 *
 * Only on the site: the streets around it are context, which people walk
 * through (walkers.ts) but don't linger in — and where the felt-temperature
 * field, which decides where people stay, says nothing.
 *
 * Every candidate spot (a bench seat, a point along a path, the counter of a
 * kiosk...) gets a fixed random draw from a hash of its own id, and is
 * occupied when that draw is under the current activity level. Two useful
 * consequences: raising the level only ever *adds* people (dragging the hour
 * slider towards the evening fills the square rather than reshuffling it),
 * and adding a card only affects the spots that card creates — everyone
 * else stays exactly where they were.
 *
 * Felt temperature (comfort.ts) keeps some people away and gathers the
 * others where it's comfortable (`comfortOccupancy`). Then each spot's
 * occupancy depends on every other spot's comfort, so both consequences
 * hold only roughly: a card that adds shade draws people from elsewhere.
 */

import type { DiscreteElement } from "../../api/types";
import { toLocal, type GeoAnchor } from "../geo";
import { elementYaw, hashString, hashUnit } from "../hash";
import { insideRing, type Footprint } from "../walk";
import type { CrowdActivity } from "./activity";
import { inThermalStress, stayFactor, type FeltSampler } from "./comfort";
import { CHARACTERS, standingHeight } from "./characters";
import type { DogBreed } from "./walkers";

export interface PersonPlacement {
  /** Stable across replans, so an unchanged person isn't rebuilt. */
  id: string;
  pose: "sitting" | "standing";
  /** Standing: feet. Sitting: the point between the hip joints, on the seat. */
  x: number;
  z: number;
  /** Facing direction, radians about +Y (0 faces +Z, like the furniture). */
  yaw: number;
  character: number;
  height: number;
  clip: "Idle" | "Idle_Neutral";
  /** 0-1 offset into the idle loop, so neighbours don't breathe in sync. */
  phase: number;
  /** People sharing a key are together (same bench, same chat, same kiosk)
   * and look at each other — see gaze.ts. Null for someone on their own. */
  group: string | null;
  /** A dog lying or standing next to them, on a leash. */
  dog: DogBreed | null;
}

// People walking through, at the busiest (a summer evening); fewer at other
// times, following the activity level. After dark, more of the people
// around walk than stop.
const WALKERS_AT_PEAK = 250;
const WALKERS_AT_PEAK_DARK = 330;
// How many may stop at most, whatever the spots: a performance bound, as
// each person is a skinned mesh, one draw call plus its shadow.
const MAX_STOPPING = 250;
// Share of people on their own (or alone on a bench) who have a dog.
const DOG_SHARE = 0.1;

// Share of the level that turns into occupancy, per kind of spot (how busy
// the square gets): benches full only at the peak, one seat of each first;
// above 1, a kind of spot is full well before the peak.
const BENCH_FIRST_SEAT = 1;
const BENCH_SECOND_SEAT = 0.5;
const PATH_GROUP = 0.1;
const ATTRACTOR = 4;

// How strongly the people who still stop pick the most comfortable spots
// (see `comfortOccupancy`): 1, each spot thins by its own comfort.
const COMFORT_SELECTIVITY = 3;

const PATH_SPOT_SPACING_M = 6;
// At night people only linger where it's lit — the same radius the safety
// indicator counts as illuminated (civic_twin/domains/urban/parameters.py).
const LIT_RADIUS_M = 12;

// Bench seat slots, along the bench (see buildBenchGeometry: 1.8 m long).
const BENCH_SEATS = [-0.45, 0.42];
// Hip joints sit this far in front of the bench's centre line, i.e. with the
// back against the backrest.
const BENCH_HIP_FORWARD_M = -0.13;

// Spots around social furniture, in the element's own frame (+Z is its
// front — see builders/furniture.ts for each geometry's layout).
const ATTRACTOR_SPOTS: Partial<Record<DiscreteElement["type"], [number, number][]>> = {
  kiosk: [
    [-0.5, 2.1],
    [0.55, 2.3],
  ],
  playground: [
    [0.8, -2.3],
    [-1.4, 3.0],
    [3.4, -0.6],
  ],
  fitness_area: [
    [1.9, -0.9],
    [-0.4, 3.4],
  ],
  pergola: [
    [-0.5, 0.2],
    [0.5, 0.2],
  ],
};

/** Deterministic 0-1 draw for a key. */
function draw(key: string): number {
  return hashUnit(key);
}

interface Candidate extends PersonPlacement {
  /** The occupancy draw relative to its spot's threshold (0-1): lowest
   * survive the MAX_STOPPING cut. Relative, so the cut thins every kind of
   * spot evenly rather than favouring the ones with the lowest threshold. */
  u: number;
}

function person(
  id: string,
  pose: PersonPlacement["pose"],
  x: number,
  z: number,
  yaw: number,
  u: number,
  group: string | null
): Candidate {
  const character = hashString(`${id}:character`) % CHARACTERS.length;
  return {
    id,
    pose,
    x,
    z,
    yaw,
    character,
    height: standingHeight(CHARACTERS[character].build, draw(`${id}:height`)),
    clip: pose === "sitting" || draw(`${id}:clip`) < 0.5 ? "Idle_Neutral" : "Idle",
    phase: draw(`${id}:phase`),
    group,
    dog: null,
    u,
  };
}

/** A local point `(side, front)` in the frame of something at (x, z) facing `yaw`. */
function inFrame(x: number, z: number, yaw: number, side: number, front: number): [number, number] {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [x + side * cos + front * sin, z - side * sin + front * cos];
}

/** How many people walk through in comfortable weather (see walkers.ts);
 * how many stop is up to the spots (`planCrowd`). */
export function walkerCount(activity: CrowdActivity): number {
  return Math.round(activity.level * (activity.dark ? WALKERS_AT_PEAK_DARK : WALKERS_AT_PEAK));
}

/** What the temperature costs: the people expected to stop at this hour in
 * comfortable weather, and in this one, and how many of these are in
 * thermal stress. Expected values (occupancy × people per spot), not the
 * draws, so smooth from hour to hour. */
export interface StopTally {
  wouldStop: number;
  stop: number;
  stressed: number;
}

/** `site`: the site's boundary in the local frame, as a footprint ring. */
export function planCrowd(
  elements: DiscreteElement[],
  anchor: GeoAnchor,
  footprints: Footprint[],
  site: Footprint,
  activity: CrowdActivity,
  felt: FeltSampler | null = null,
  tally: StopTally | null = null
): PersonPlacement[] {
  const level = activity.level;
  if (level <= 0) return [];

  const lights = elements
    .filter((e) => e.type === "streetlight" && e.geometry.type === "Point")
    .map((e) => toLocal(anchor, ...((e.geometry as GeoJSON.Point).coordinates as [number, number])));
  const usable = (x: number, z: number) => {
    if (!insideRing(site, x, z)) return false;
    if (footprints.some((ring) => insideRing(ring, x, z))) return false;
    if (!activity.dark) return true;
    return lights.some(([lx, lz]) => (lx - x) ** 2 + (lz - z) ** 2 <= LIT_RADIUS_M ** 2);
  };

  // First every usable spot, with how full it would be in comfortable
  // weather (`base`) and how comfortable it is (`stay`); then who's there.
  interface Spot {
    id: string;
    base: number;
    stay: number;
    celsius: number | null;
    people: number;
    /** The people there, given their draw relative to the spot's threshold. */
    occupy: (u: number) => Candidate[];
  }
  const spots: Spot[] = [];
  const addSpot = (
    id: string,
    share: number,
    x: number,
    z: number,
    people: number,
    occupy: (u: number) => Candidate[]
  ) => {
    if (!usable(x, z)) return;
    const base = Math.min(1, level * share);
    if (base <= 0) return;
    const celsius = felt ? felt(x, z) : null;
    spots.push({ id, base, stay: stayFactor(celsius), celsius, people, occupy });
  };

  for (const element of elements) {
    if (element.geometry.type === "Point") {
      const [x, z] = toLocal(anchor, element.geometry.coordinates[0], element.geometry.coordinates[1]);
      const yaw = elementYaw(element.id);

      if (element.type === "bench") {
        BENCH_SEATS.forEach((side, seat) => {
          const id = `${element.id}:seat${seat}`;
          const [px, pz] = inFrame(x, z, yaw, side, BENCH_HIP_FORWARD_M);
          addSpot(id, seat === 0 ? BENCH_FIRST_SEAT : BENCH_SECOND_SEAT, px, pz, 1, (u) => [
            person(id, "sitting", px, pz, yaw, u, element.id),
          ]);
        });
        continue;
      }

      ATTRACTOR_SPOTS[element.type]?.forEach(([side, front], i) => {
        const id = `${element.id}:spot${i}`;
        const [px, pz] = inFrame(x, z, yaw, side, front);
        // Facing the thing they came for.
        addSpot(id, ATTRACTOR, px, pz, 1, (u) => [
          person(id, "standing", px, pz, Math.atan2(x - px, z - pz), u, element.id),
        ]);
      });
      continue;
    }

    if (element.type === "path") {
      for (const spot of pathSpots(element, anchor)) {
        addSpot(spot.id, PATH_GROUP, spot.x, spot.z, groupSize(spot.id), (u) => group(spot.id, spot.x, spot.z, u));
      }
    }
  }

  // The temperature keeps away as many people as each spot's `stay` says,
  // in all; but those who still come take the most comfortable spots first,
  // so the people go to the shade (or the sun) rather than thin out evenly.
  const occupancy = comfortOccupancy(spots);
  if (tally) {
    spots.forEach((spot, i) => {
      tally.wouldStop += spot.base * spot.people;
      tally.stop += spot.base * spot.stay * spot.people;
      if (spot.celsius !== null && inThermalStress(spot.celsius)) tally.stressed += occupancy[i] * spot.people;
    });
  }

  const candidates: Candidate[] = [];
  spots.forEach((spot, i) => {
    const threshold = occupancy[i];
    const u = draw(spot.id);
    if (u < threshold) candidates.push(...spot.occupy(u / threshold));
  });

  candidates.sort((a, b) => a.u - b.u);
  const chosen = candidates.slice(0, MAX_STOPPING);
  // Dogs only with someone on their own: next to a pair on a bench or a
  // chatting group there's no obvious owner, and no room.
  const groupSizes = new Map<string, number>();
  for (const person of chosen) if (person.group) groupSizes.set(person.group, (groupSizes.get(person.group) ?? 0) + 1);
  for (const person of chosen) {
    const alone = !person.group || groupSizes.get(person.group) === 1;
    const dogDraw = draw(`${person.id}:dog`);
    if (alone && dogDraw < DOG_SHARE) person.dog = "husky";
  }
  return chosen.map(({ u: _u, ...placement }) => placement);
}

/** Each spot's occupancy: `base` × `stay`^COMFORT_SELECTIVITY, scaled so
 * the people expected in all stay Σ `base` × `stay`, and capped at 1 (a
 * full spot). At 1 that's `base` × `stay`: every spot thins by its own
 * comfort. Higher, the people who still come gather where it's most
 * comfortable — beyond its usual occupancy, up to full: on a hot
 * afternoon a shaded bench fills even at an hour it usually wouldn't. */
function comfortOccupancy(spots: { base: number; stay: number; people: number }[]): number[] {
  const weights = spots.map((spot) => spot.base * spot.stay ** COMFORT_SELECTIVITY);
  const occupancy = (scale: number) => weights.map((weight) => Math.min(1, scale * weight));
  const expected = (scale: number) => occupancy(scale).reduce((sum, value, i) => sum + value * spots[i].people, 0);
  const target = spots.reduce((sum, spot) => sum + spot.base * spot.stay * spot.people, 0);
  // `expected` grows with the scale, up to every spot full once the
  // smallest weight times it reaches 1 — never short of the target.
  let low = 0;
  let high = 1 / Math.max(1e-9, Math.min(1, ...weights));
  for (let k = 0; k < 40; k++) {
    const mid = (low + high) / 2;
    if (expected(mid) < target) low = mid;
    else high = mid;
  }
  return occupancy(high);
}

/** Points every PATH_SPOT_SPACING_M along a path, just off its centreline. */
function pathSpots(element: DiscreteElement, anchor: GeoAnchor): { id: string; x: number; z: number }[] {
  const lines =
    element.geometry.type === "LineString"
      ? [element.geometry.coordinates]
      : element.geometry.type === "MultiLineString"
        ? element.geometry.coordinates
        : [];
  const spots: { id: string; x: number; z: number }[] = [];
  lines.forEach((line, lineIndex) => {
    const points = line.map(([lng, lat]) => toLocal(anchor, lng, lat));
    // Starting offset varies per path, so short paths aren't all skipped.
    let next = draw(`${element.id}:${lineIndex}:start`) * PATH_SPOT_SPACING_M;
    let travelled = 0;
    for (let i = 1; i < points.length; i++) {
      const [ax, az] = points[i - 1];
      const [bx, bz] = points[i];
      const length = Math.hypot(bx - ax, bz - az);
      while (length > 0 && next <= travelled + length) {
        const f = (next - travelled) / length;
        const heading = Math.atan2(bx - ax, bz - az);
        const id = `${element.id}:${lineIndex}:${spots.length}`;
        const side = (draw(`${id}:side`) < 0.5 ? -1 : 1) * (0.4 + draw(`${id}:offset`) * 0.5);
        const [x, z] = inFrame(ax + (bx - ax) * f, az + (bz - az) * f, heading, side, 0);
        spots.push({ id, x, z });
        next += PATH_SPOT_SPACING_M;
      }
      travelled += length;
    }
  });
  return spots;
}

/** Two or three people standing together at a spot, facing each other.
 * Never one: someone standing alone in the middle of a path, going nowhere,
 * reads as a mistake — people on their own are the walkers (walkers.ts). */
function groupSize(id: string): number {
  return draw(`${id}:size`) < 0.7 ? 2 : 3;
}

function group(id: string, x: number, z: number, u: number): Candidate[] {
  const size = groupSize(id);
  const radius = size === 2 ? 0.45 : 0.55;
  const start = draw(`${id}:angle`) * Math.PI * 2;
  return Array.from({ length: size }, (_, i) => {
    const angle = start + (i * Math.PI * 2) / size;
    const px = x + Math.sin(angle) * radius;
    const pz = z + Math.cos(angle) * radius;
    return person(`${id}:${i}`, "standing", px, pz, angle + Math.PI, u, id);
  });
}
