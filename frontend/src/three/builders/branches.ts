/** Visible bark/limb geometry for a tree — the coarse levels of its
 * `treeStructure.ts` structure, rendered year-round (not just in winter):
 * real trees show trunk and major limbs through gaps in the canopy too, and
 * that's part of what makes even a fully-leafed tree read as a real branching
 * object rather than a green blob with a stick underneath it.
 *
 * Hand-built from scratch (vertex/index arrays written directly, one shared
 * buffer per tree) rather than a downloaded tree asset — same reasoning
 * `foliageCards.ts` documents for leaves: this stays cheap enough to draw
 * ~200 of, which a realistic branch/bark asset is not.
 *
 * This used to build each branch segment as its own `THREE.CylinderGeometry`
 * (up to ~1200 per tree) and merge them — simple, but measured at ~1.85s of
 * a ~3.5s scene rebuild once tree density went up, by a wide margin the
 * single biggest cost in the whole scene. Every other hand-built geometry
 * in this codebase (`foliageCards.ts`, `needles.ts`, `crown.ts` before it)
 * already writes vertices directly into shared arrays instead of
 * constructing-then-merging separate geometry objects; this was the one
 * holdout. Same output, no per-segment object/GC overhead.
 */

import * as THREE from "three";
import type { BranchSegment, TreeStructure } from "./treeStructure";

/** Low, matching how thin these are at any distance worth rendering them at
 * — a branch a few centimetres across doesn't need a round cross section to
 * read correctly. */
const RADIAL_SEGMENTS = 4;

/** Appends one tapered cylinder (sides + two end caps, matching what the
 * old per-segment `CylinderGeometry` produced) directly into the shared
 * position/normal/index arrays — see module docstring for why this replaced
 * building-then-merging separate geometry objects. */
function addSegment(
  positions: number[],
  normals: number[],
  indices: number[],
  segment: BranchSegment
): void {
  const { start, end, radiusStart, radiusEnd } = segment;
  const length = start.distanceTo(end);
  if (length < 1e-6) return;

  const forward = end.clone().sub(start).divideScalar(length);
  // Any vector not parallel to `forward` works to start the basis; picking
  // the world axis it aligns with least avoids a degenerate cross product —
  // same trick used throughout treeStructure.ts's own tiltDirection.
  const reference = Math.abs(forward.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(reference, forward).normalize();
  const up = new THREE.Vector3().crossVectors(forward, right);

  const ringBase = positions.length / 3;
  const normal = new THREE.Vector3();
  const point = new THREE.Vector3();

  // Two rings (base, tip), each vertex carrying its own outward radial
  // normal — matches CylinderGeometry's own convention of not sharing
  // vertices between differently-shaded faces. Unrolled rather than looped
  // over a [[radius, centre], ...] literal: that literal was a fresh array
  // allocated on every one of ~1200 segments × ~217 trees calls, real
  // (if smaller than foliage's) avoidable GC pressure.
  for (let ring = 0; ring < 2; ring++) {
    const radius = ring === 0 ? radiusStart : radiusEnd;
    const centre = ring === 0 ? start : end;
    for (let i = 0; i < RADIAL_SEGMENTS; i++) {
      const theta = (i / RADIAL_SEGMENTS) * Math.PI * 2;
      normal.copy(right).multiplyScalar(Math.cos(theta)).addScaledVector(up, Math.sin(theta));
      point.copy(centre).addScaledVector(normal, radius);
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
    }
  }

  for (let i = 0; i < RADIAL_SEGMENTS; i++) {
    const next = (i + 1) % RADIAL_SEGMENTS;
    const bl = ringBase + i;
    const br = ringBase + next;
    const tl = ringBase + RADIAL_SEGMENTS + i;
    const tr = ringBase + RADIAL_SEGMENTS + next;
    indices.push(bl, br, tr, bl, tr, tl);
  }

  // End caps — small triangle fans, flat-shaded along the segment's own
  // axis. Every segment gets both, same as the old per-segment
  // CylinderGeometry did (a child segment's base cap sits flush against its
  // parent's tip cap, invisible either way, but harmless and simpler than
  // special-casing which ends actually need one).
  const baseCentre = positions.length / 3;
  positions.push(start.x, start.y, start.z);
  normals.push(-forward.x, -forward.y, -forward.z);
  for (let i = 0; i < RADIAL_SEGMENTS; i++) {
    const next = (i + 1) % RADIAL_SEGMENTS;
    indices.push(baseCentre, ringBase + next, ringBase + i);
  }

  const tipCentre = positions.length / 3;
  positions.push(end.x, end.y, end.z);
  normals.push(forward.x, forward.y, forward.z);
  for (let i = 0; i < RADIAL_SEGMENTS; i++) {
    const next = (i + 1) % RADIAL_SEGMENTS;
    indices.push(tipCentre, ringBase + RADIAL_SEGMENTS + i, ringBase + RADIAL_SEGMENTS + next);
  }
}

/** Builds the visible (coarse) part of a tree's structure into one bark
 * geometry. `renderMaxLevel` is the same cutoff the original bare-winter-only
 * version of this file used (3) — kept as a parameter rather than a
 * constant so callers stay explicit about why it's bounded (finer twigs
 * below this level exist only as leaf anchors, see `treeStructure.ts`, and
 * would be visual clutter/wasted triangles to also render as bark). */
export function buildBarkGeometry(structure: TreeStructure, renderMaxLevel: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (const segment of structure.segments) {
    if (segment.level <= renderMaxLevel) addSegment(positions, normals, indices, segment);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}
