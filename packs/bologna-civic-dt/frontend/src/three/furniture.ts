/** Composite geometry for street furniture.
 *
 * Benches are the object a citizen is most likely to be standing next to in an
 * eye-level view, and Piazza Dante has 86 of them, so a plain box reads as a
 * placeholder immediately. These are still simple — slats, legs, a backrest —
 * but the silhouette is what matters at conversational distance.
 *
 * Each is merged into a single geometry so it can be drawn as one
 * InstancedMesh rather than a group per element.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

function box(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.translate(x, y, z);
  return geometry;
}

/** A park bench, 1.8 m long, origin at ground level between the legs. */
export function buildBenchGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Seat: three slats with gaps, which is what makes it read as a bench
  // rather than a plinth once the sun casts through it.
  for (let i = 0; i < 3; i++) {
    parts.push(box(1.8, 0.05, 0.13, 0, 0.45, -0.18 + i * 0.17));
  }
  // Backrest, tilted slightly back.
  for (let i = 0; i < 2; i++) {
    const slat = new THREE.BoxGeometry(1.8, 0.13, 0.05);
    slat.rotateX(-0.18);
    slat.translate(0, 0.72 + i * 0.17, -0.28);
    parts.push(slat);
  }
  // Legs.
  for (const x of [-0.75, 0.75]) {
    parts.push(box(0.08, 0.45, 0.5, x, 0.225, 0));
    parts.push(box(0.06, 0.35, 0.06, x, 0.63, -0.27));
  }

  return mergeGeometries(parts, false)!;
}

/** A basin fountain: low circular wall, water surface, central spout. */
export function buildFountainGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const wall = new THREE.CylinderGeometry(1.4, 1.5, 0.55, 20, 1, true);
  wall.translate(0, 0.275, 0);
  parts.push(wall);

  // Water sits just below the rim.
  const water = new THREE.CircleGeometry(1.4, 20);
  water.rotateX(-Math.PI / 2);
  water.translate(0, 0.45, 0);
  parts.push(water);

  const column = new THREE.CylinderGeometry(0.12, 0.18, 1.1, 10);
  column.translate(0, 0.55, 0);
  parts.push(column);

  return mergeGeometries(parts, false)!;
}

/** Height of the globe's centre, where the `PointLight` sits too (see
 * `builders/streetlights.ts`). */
export const STREETLIGHT_GLOBE_Y_M = 4.3;

/** A streetlight's metal parts: slim pole, plus a conical cap over the globe
 * with a small finial on top — a bare ball on a stick read as a placeholder,
 * the shade is what makes it read as a street lamp. The actual night-time
 * glow is a separate `THREE.PointLight` per instance (see
 * `builders/streetlights.ts`) — this is just the visual pole, safe to
 * instance like any other furniture. */
export function buildStreetlightPoleGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const pole = new THREE.CylinderGeometry(0.06, 0.08, 4.2, 8);
  pole.translate(0, 2.1, 0);
  parts.push(pole);

  // Closed (not open-ended), so the underside of the shade is a solid disc
  // that the lamp lights from below at night rather than a see-through hole.
  const cap = new THREE.CylinderGeometry(0.06, 0.3, 0.16, 16);
  cap.translate(0, STREETLIGHT_GLOBE_Y_M + 0.19, 0);
  parts.push(cap);

  const finial = new THREE.SphereGeometry(0.045, 8, 6);
  finial.translate(0, STREETLIGHT_GLOBE_Y_M + 0.3, 0);
  parts.push(finial);

  return mergeGeometries(parts, false)!;
}

/** The frosted globe under the cap — a separate mesh from the pole so only
 * the globe glows at night, not the whole post. */
export function buildStreetlightGlobeGeometry(): THREE.BufferGeometry {
  const globe = new THREE.SphereGeometry(0.17, 12, 8);
  globe.scale(1, 0.8, 1);
  globe.translate(0, STREETLIGHT_GLOBE_Y_M, 0);
  return globe;
}

/** A traffic signal: slim pole + a compact housing near the top. No
 * per-light red/yellow/green detail or real orientation (OSM's
 * `highway=traffic_signals` node carries neither) — this is meant to read
 * as "there's a signal here", not a lit prop. */
export function buildTrafficSignalGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const pole = new THREE.CylinderGeometry(0.05, 0.06, 3.0, 8);
  pole.translate(0, 1.5, 0);
  parts.push(pole);

  parts.push(box(0.22, 0.55, 0.18, 0, 2.85, 0));

  return mergeGeometries(parts, false)!;
}

const PERGOLA_FOOTPRINT_M: Record<string, { size: number; height: number }> = {
  small: { size: 3, height: 2.4 },
  medium: { size: 4, height: 2.6 },
  large: { size: 5, height: 2.8 },
};

/** A pergola: four corner posts + a flat lattice roof of crossbeams, sized by
 * the card's `size` param. */
export function buildPergolaGeometry(size: string): THREE.BufferGeometry {
  const { size: span, height } = PERGOLA_FOOTPRINT_M[size] ?? PERGOLA_FOOTPRINT_M.medium;
  const half = span / 2 - 0.15;
  const parts: THREE.BufferGeometry[] = [];

  for (const x of [-half, half]) {
    for (const z of [-half, half]) {
      parts.push(box(0.14, height, 0.14, x, height / 2, z));
    }
  }

  // Crossbeams along one axis, then slats along the other, so the roof reads
  // as a lattice rather than a solid slab from below.
  const beamCount = 3;
  for (let i = 0; i < beamCount; i++) {
    const z = -half + (span * i) / (beamCount - 1);
    parts.push(box(span, 0.1, 0.12, 0, height, z));
  }
  const slatCount = 5;
  for (let i = 0; i < slatCount; i++) {
    const x = -half + (span * i) / (slatCount - 1);
    parts.push(box(0.08, 0.06, span, x, height + 0.08, 0));
  }

  return mergeGeometries(parts, false)!;
}

/** A small kiosk: box body, counter, and an angled awning. */
export function buildKioskGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  parts.push(box(2.2, 2.1, 2.0, 0, 1.05, 0));

  const counter = box(2.4, 0.9, 0.5, 0, 0.45, 1.25);
  parts.push(counter);

  const awning = new THREE.BoxGeometry(2.6, 0.08, 1.4);
  awning.rotateX(-0.35);
  awning.translate(0, 2.25, 1.6);
  parts.push(awning);

  return mergeGeometries(parts, false)!;
}

/** A small play structure: platform + slide + a swing frame beside it —
 * enough silhouette to read as "playground" at conversational distance
 * without modelling individual equipment realistically. */
export function buildPlaygroundGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Platform on four posts.
  for (const x of [-0.9, 0.9]) {
    for (const z of [-0.6, 0.6]) {
      parts.push(box(0.1, 1.2, 0.1, x, 0.6, z));
    }
  }
  parts.push(box(2.0, 0.1, 1.4, 0, 1.25, 0));

  // Slide ramp down one side.
  const slide = new THREE.BoxGeometry(0.8, 0.06, 2.2);
  slide.rotateX(0.55);
  slide.translate(1.6, 0.75, 1.6);
  parts.push(slide);

  // A-frame swing set beside the platform: each pair of legs leans in to
  // meet under the crossbar (a positive rotation about Z tips a leg's top
  // towards -X).
  const swingX = -2.6;
  for (const dz of [-0.9, 0.9]) {
    const leg1 = new THREE.BoxGeometry(0.1, 2.0, 0.1);
    leg1.rotateZ(-0.3);
    leg1.translate(swingX - 0.3, 1.0, dz);
    parts.push(leg1);
    const leg2 = new THREE.BoxGeometry(0.1, 2.0, 0.1);
    leg2.rotateZ(0.3);
    leg2.translate(swingX + 0.3, 1.0, dz);
    parts.push(leg2);
  }
  parts.push(box(0.1, 0.1, 1.9, swingX, 2.0, 0));
  parts.push(box(0.4, 0.05, 0.15, swingX, 1.0, -0.9));
  parts.push(box(0.4, 0.05, 0.15, swingX, 1.0, 0.9));

  return mergeGeometries(parts, false)!;
}

/** A compact fitness area: a pull-up/dip frame plus a low balance beam. */
export function buildFitnessGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  for (const x of [-1.0, 1.0]) {
    parts.push(box(0.1, 2.2, 0.1, x, 1.1, 0));
  }
  parts.push(box(2.1, 0.1, 0.1, 0, 2.2, 0));

  const beam = box(0.15, 0.4, 2.2, 0, 0.2, 1.8);
  parts.push(beam);

  return mergeGeometries(parts, false)!;
}
