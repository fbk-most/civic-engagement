/** Where people sit and stand in the 3D view — a pure function of the scene's
 * elements and the time of day, so it's reproducible (a shared "Copia URL
 * vista" link shows the same crowd) and cheap to recompute.
 *
 * Every candidate spot (a bench seat, a point along a path, the counter of a
 * kiosk...) gets a fixed random draw from a hash of its own id, and is
 * occupied when that draw is under the current activity level. Two useful
 * consequences: raising the level only ever *adds* people (dragging the hour
 * slider towards the evening fills the square rather than reshuffling it),
 * and adding a card only affects the spots that card creates — everyone
 * else stays exactly where they were.
 */

import type { DiscreteElement } from "../../api/types";
import { toLocal, type GeoAnchor } from "../geo";
import { elementYaw, hashString } from "../hash";
import { insideRing, type Footprint } from "../walk";
import type { CrowdActivity } from "./activity";
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

// Everyone in the scene, standing, sitting and walking, at the busiest (a
// summer evening); fewer at other times, following the activity level.
// Also a performance bound: each person is a skinned mesh, one draw call
// plus its shadow.
const PEOPLE_AT_PEAK = 500;
// Share of them standing or sitting; the rest walk (see walkers.ts). After
// dark fewer linger, and only where it's lit.
const STANDING_SHARE = 1 / 2;
const STANDING_SHARE_DARK = 1 / 3;
// Share of people on their own (or alone on a bench) who have a dog.
const DOG_SHARE = 0.1;

// Share of the level that turns into occupancy, per kind of spot. Above 1,
// a kind of spot is full well before the peak (every seat taken by
// mid-afternoon); from there, only the paths take more people.
const BENCH_FIRST_SEAT = 2.75;
const BENCH_SECOND_SEAT = 1.25;
const PATH_GROUP = 0.2;
const ATTRACTOR = 4;

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
  return hashString(key) / 2 ** 32;
}

interface Candidate extends PersonPlacement {
  /** The occupancy draw relative to its spot's threshold (0-1): lowest
   * survive the `crowdSize` cut. Relative, so the cut thins every kind of
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

/** How many people are in the scene, and how many of them stand or sit
 * (the rest walk) — before `planCrowd` finds places for them: if there are
 * fewer spots (at night, only lit ones count), the walkers make up the rest. */
export function crowdSize(activity: CrowdActivity): { total: number; standing: number } {
  const total = Math.round(activity.level * PEOPLE_AT_PEAK);
  return { total, standing: Math.round(total * (activity.dark ? STANDING_SHARE_DARK : STANDING_SHARE)) };
}

export function planCrowd(
  elements: DiscreteElement[],
  anchor: GeoAnchor,
  footprints: Footprint[],
  activity: CrowdActivity
): PersonPlacement[] {
  const level = activity.level;
  if (level <= 0) return [];
  const occupancy = (share: number) => Math.min(1, level * share);

  const lights = elements
    .filter((e) => e.type === "streetlight" && e.geometry.type === "Point")
    .map((e) => toLocal(anchor, ...((e.geometry as GeoJSON.Point).coordinates as [number, number])));
  const usable = (x: number, z: number) => {
    if (footprints.some((ring) => insideRing(ring, x, z))) return false;
    if (!activity.dark) return true;
    return lights.some(([lx, lz]) => (lx - x) ** 2 + (lz - z) ** 2 <= LIT_RADIUS_M ** 2);
  };

  const candidates: Candidate[] = [];

  for (const element of elements) {
    if (element.geometry.type === "Point") {
      const [x, z] = toLocal(anchor, element.geometry.coordinates[0], element.geometry.coordinates[1]);
      const yaw = elementYaw(element.id);

      if (element.type === "bench") {
        BENCH_SEATS.forEach((side, seat) => {
          const id = `${element.id}:seat${seat}`;
          const threshold = occupancy(seat === 0 ? BENCH_FIRST_SEAT : BENCH_SECOND_SEAT);
          const u = draw(id);
          if (u >= threshold) return;
          const [px, pz] = inFrame(x, z, yaw, side, BENCH_HIP_FORWARD_M);
          if (usable(px, pz)) candidates.push(person(id, "sitting", px, pz, yaw, u / threshold, element.id));
        });
        continue;
      }

      const spots = ATTRACTOR_SPOTS[element.type];
      if (spots) {
        spots.forEach(([side, front], i) => {
          const id = `${element.id}:spot${i}`;
          const threshold = occupancy(ATTRACTOR);
          const u = draw(id);
          if (u >= threshold) return;
          const [px, pz] = inFrame(x, z, yaw, side, front);
          if (!usable(px, pz)) return;
          // Facing the thing they came for.
          candidates.push(person(id, "standing", px, pz, Math.atan2(x - px, z - pz), u / threshold, element.id));
        });
      }
      continue;
    }

    if (element.type === "path") {
      for (const spot of pathSpots(element, anchor)) {
        const threshold = occupancy(PATH_GROUP);
        const u = draw(spot.id);
        if (u >= threshold) continue;
        if (!usable(spot.x, spot.z)) continue;
        candidates.push(...group(spot.id, spot.x, spot.z, u / threshold));
      }
    }
  }

  candidates.sort((a, b) => a.u - b.u);
  const chosen = candidates.slice(0, crowdSize(activity).standing);
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
function group(id: string, x: number, z: number, u: number): Candidate[] {
  const size = draw(`${id}:size`) < 0.7 ? 2 : 3;
  const radius = size === 2 ? 0.45 : 0.55;
  const start = draw(`${id}:angle`) * Math.PI * 2;
  return Array.from({ length: size }, (_, i) => {
    const angle = start + (i * Math.PI * 2) / size;
    const px = x + Math.sin(angle) * radius;
    const pz = z + Math.cos(angle) * radius;
    return person(`${id}:${i}`, "standing", px, pz, angle + Math.PI, u, id);
  });
}
