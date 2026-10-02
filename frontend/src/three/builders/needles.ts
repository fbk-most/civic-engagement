/** Geometric (untextured) needle clusters for evergreen trees, anchored to
 * the same twig structure `foliageCards.ts` uses for broadleaf clusters
 * (`treeStructure.ts`).
 *
 * Needles are thin enough that a textured card has the identical "flat
 * sheet" problem broadleaf cards did — at the scale a real needle is (a few
 * mm wide), there's no card size that reads as anything but a printed
 * pattern. Going fully geometric instead (a handful of thin triangles
 * radiating from each twig) is both cheaper (no atlas, no alpha test, one
 * triangle per needle instead of a textured quad) and correct at this
 * scale.
 */

import * as THREE from "three";
import type { TreeStructure, TwigNode } from "./treeStructure";

/** Dark, slightly blue-green — evergreen needles read darker and cooler
 * than broadleaf's summer palette. Picked per twig cluster, not per needle:
 * a real sprig is close to one uniform colour. */
const NEEDLE_PALETTE = [0x1c3a28, 0x224a30, 0x18321f, 0x203c2a];

// Lowered twice, now raised back up substantially: [14,22] -> [6,10] (once
// anchors moved from tip-clusters to a secondary-branch order) -> [4,7]
// (once anchor density itself was fixed) -> [32,46] (live-scene feedback:
// "not enough needles, pine still naked") -> this. `frontend/src/treeLab.ts`'s
// width x count sweep found width/count alone plateaus well short of "full"
// even at generous values — see NEEDLE_CONE_DEG below for what actually
// closed the gap. Needle build time has real headroom (a few hundred ms of
// a multi-second vegetation build, see vegetation.ts's docstring).
const NEEDLES_PER_TWIG_RANGE: [number, number] = [55, 75];
/** Real spruce/fir needles are only 1-2cm long and ~1mm wide — rendered at
 * that true scale, individual needle triangles fall below reliable
 * rasterization coverage at any normal viewing distance and effectively
 * vanish (confirmed empirically: they render fine at 10x this size, and
 * disappear near the real one). Exaggerated somewhat beyond real scale so
 * they survive on screen, while staying far smaller than a broadleaf
 * cluster so the silhouette still reads as needle-like, not leafy.
 *
 * Width went through several rounds: an initial 0.1m read as a fern/bamboo
 * frond (needles wider than the twig bearing them); live-scene feedback
 * pinned this down concretely — "a branch is only 3-4 needle-widths wide" —
 * against a secondary-branch radius (treeStructure.ts's
 * `secondaryRadiusFraction`) that's typically 2-4cm in diameter. */
const NEEDLE_LENGTH_M = 0.32;
const NEEDLE_WIDTH_M = 0.02;
/** How far a needle is allowed to splay from its twig's own direction.
 * Tightened from an initial 32° to 20° to 15° across earlier rounds chasing
 * a "windswept"/frond look — overcorrected: at 15°, every needle from one
 * anchor points in nearly the same direction, so a cluster reads as a flat
 * tuft no matter how many needles or how wide they are (confirmed via
 * `treeLab.ts`'s cone-angle x length sweep — width/count alone plateaued
 * well short of "full" until this was widened). A real fascicle splays
 * enough to read as a small 3D puff, not a flat fan — 50° is what that
 * sweep found actually got there. */
const NEEDLE_CONE_DEG = 50;

/** Overrides for the constants above — same pattern as
 * `treeStructure.ts`'s `TreeStructureOptions`, for the same reason: needle
 * shape/density went through several rounds of one-value-at-a-time guessing
 * against live-scene screenshots before it was right, which is slow and
 * hard to compare. Letting `frontend/src/treeLab.ts` sweep these directly
 * (see its needle-parameter grid) is the fix — all optional, omitting them
 * (as `vegetation.ts`'s real call does) reproduces today's shipped
 * defaults exactly. */
export interface NeedleOptions {
  lengthM?: number;
  widthM?: number;
  countRange?: [number, number];
  coneDeg?: number;
}

/** Small deterministic PRNG — same algorithm `treeStructure.ts` uses. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tilts `direction` away from itself by `tiltRad`, around an axis chosen
 * by `azimuthRad`, writing the result into `out` — same construction
 * `treeStructure.ts`/`foliageCards.ts` each already carry their own copy
 * of, but taking `out` plus scratch vectors from the caller rather than
 * allocating four new `Vector3`s per call: this runs once per needle, and
 * at real tree counts/densities that was over a million allocations per
 * scene rebuild, a meaningful share of foliage generation's cost. */
function tiltDirectionInto(
  out: THREE.Vector3,
  direction: THREE.Vector3,
  tiltRad: number,
  azimuthRad: number,
  scratchRef: THREE.Vector3,
  scratchTangent: THREE.Vector3,
  scratchBitangent: THREE.Vector3
): void {
  scratchRef.set(0, 1, 0);
  if (Math.abs(direction.y) > 0.9) scratchRef.set(1, 0, 0);
  scratchTangent.crossVectors(direction, scratchRef).normalize();
  scratchBitangent.crossVectors(direction, scratchTangent);
  scratchTangent.multiplyScalar(Math.cos(azimuthRad)).addScaledVector(scratchBitangent, Math.sin(azimuthRad));
  out.copy(direction).applyAxisAngle(scratchTangent, tiltRad).normalize();
}

/** Fisher-Yates, using the tree's own seeded RNG so twig selection is
 * deterministic across reloads. */
function shuffled<T>(items: T[], random: () => number): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * @param density 0 (no needles) to 1 (full) — evergreens pass a constant 1
 *   from `vegetation.ts` (see `sun.leafDensity`'s docstring), but this
 *   still takes the parameter for symmetry with `foliageCards.buildLeafGeometry`
 *   and in case a future scenario wants partial defoliation (storm damage,
 *   disease) independent of season.
 */
export function buildNeedleGeometry(
  structure: TreeStructure,
  seed: number,
  density: number,
  options?: NeedleOptions
): THREE.BufferGeometry | null {
  const random = mulberry32(seed);
  const candidates = structure.twigs;
  const targetTwigs = Math.round(candidates.length * Math.max(0, Math.min(1, density)));
  if (candidates.length === 0 || targetTwigs <= 0) return null;

  const lengthM = options?.lengthM ?? NEEDLE_LENGTH_M;
  const widthM = options?.widthM ?? NEEDLE_WIDTH_M;
  const countRange = options?.countRange ?? NEEDLES_PER_TWIG_RANGE;
  const coneDeg = options?.coneDeg ?? NEEDLE_CONE_DEG;

  const order = shuffled(candidates, random);

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];

  const widthDir = new THREE.Vector3();
  const needleDir = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const left = new THREE.Vector3();
  const right = new THREE.Vector3();
  const tip = new THREE.Vector3();
  const reference = new THREE.Vector3();
  const color = new THREE.Color();
  const tiltRef = new THREE.Vector3();
  const tiltTangent = new THREE.Vector3();
  const tiltBitangent = new THREE.Vector3();

  for (let i = 0; i < targetTwigs; i++) {
    const twig: TwigNode = order[i % order.length];
    color.setHex(NEEDLE_PALETTE[Math.floor(random() * NEEDLE_PALETTE.length)]);

    const [minNeedles, maxNeedles] = countRange;
    const needleCount = minNeedles + Math.floor(random() * (maxNeedles - minNeedles + 1));
    const baseAzimuth = random() * Math.PI * 2;

    for (let n = 0; n < needleCount; n++) {
      const azimuth = baseAzimuth + (n / needleCount) * Math.PI * 2 + (random() - 0.5) * 0.5;
      const coneRad = (random() * coneDeg * Math.PI) / 180;
      tiltDirectionInto(needleDir, twig.direction, coneRad, azimuth, tiltRef, tiltTangent, tiltBitangent);

      const length = lengthM * (0.7 + random() * 0.6);
      const width = widthM * (0.7 + random() * 0.6);

      reference.set(0, 1, 0);
      if (Math.abs(needleDir.y) > 0.9) reference.set(1, 0, 0);
      widthDir.crossVectors(needleDir, reference).normalize();
      normal.crossVectors(needleDir, widthDir).normalize();

      left.copy(twig.position).addScaledVector(widthDir, width / 2);
      right.copy(twig.position).addScaledVector(widthDir, -width / 2);
      tip.copy(twig.position).addScaledVector(needleDir, length);

      positions.push(left.x, left.y, left.z, right.x, right.y, right.z, tip.x, tip.y, tip.z);
      normals.push(normal.x, normal.y, normal.z, normal.x, normal.y, normal.z, normal.x, normal.y, normal.z);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b, color.r, color.g, color.b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}
