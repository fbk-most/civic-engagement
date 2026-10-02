/** Broadleaf clusters anchored to a tree's real branch/twig structure
 * (`treeStructure.ts`), rather than an independent geometric shell — see
 * that module's docstring for why twig-anchoring matters.
 *
 * Each twig gets a small **3-plane "billboard cross"**, not one flat card:
 * a single quad, however it's oriented, is a flat sheet standing in for
 * dozens of real ~5-15cm leaves, and reads as one at close range or from
 * above no matter how it's placed. Three planes sharing the twig position
 * as a pivot, spun 120° apart around the twig's own direction, guarantees
 * that from any viewing angle at least one plane shows a real cross-section
 * instead of a flat face-on sheet — the standard fix for this in the
 * tree-rendering literature (billboard clouds / leaf-cluster impostors).
 * Each plane keeps its own normal (the tilt-jittered "facing" direction,
 * rotated along with it) rather than all 3 sharing one normal, which is
 * what actually gives each face distinct shading instead of 3 identical
 * copies stacked on top of each other.
 *
 * Colour is a per-vertex attribute, not a per-mesh material tint — leaf
 * geometry from every tree in the scene is merged into shared meshes (see
 * `vegetation.ts`), so a single material can no longer vary by tree the way
 * an old per-variant cached material did.
 */

import * as THREE from "three";
import type { TreeStructure, TwigNode } from "./treeStructure";

/** World size of one leaf cluster, in metres — small enough to represent a
 * handful of real leaves rather than a "sheet". Together with
 * `FOLIAGE_UV_REPEAT` these fix apparent leaf size; the two to reach for if
 * leaves look too big/small. */
export const CLUSTER_SIZE_M = 0.42;

/** How many times the leaf atlas tile repeats across one plane. Low: at
 * cluster scale, one atlas tile already represents roughly the right leaf
 * count, so tiling several copies would undersize individual leaves. */
export const FOLIAGE_UV_REPEAT = 1.2;

/** Planes per cluster — see module docstring for why 3 rather than 1. */
const PLANES_PER_CLUSTER = 3;

/** A cluster is never more than this fraction of the crown's own diameter —
 * without a cap, a very young/small tree would get individual clusters
 * bigger than the whole tree. */
const MAX_CLUSTER_FRACTION = 0.45;

/** More than one cluster per twig on average — a real twig tip carries more
 * than one small sprig of leaves. Twigs are still selected/cycled through
 * the same seeded shuffle, so extra clusters land on twigs already used
 * (each redrawing its own random orientation/size/colour, not a literal
 * duplicate) rather than introducing new anchor points off-structure. Raised
 * twice now — first after "too few leaves", again after full-density June
 * still reading as thin as the April/October transition states. */
const CLUSTERS_PER_TWIG = 2.2;

/** How far a cluster's primary plane is allowed to tilt away from its
 * twig's growth direction before the other 2 planes are spun off it (see
 * below). Purely geometric — the *shading* normal for each plane stays its
 * own tilted-and-spun facing, only the plane's own orientation is jittered
 * first, so lighting still looks smooth while individual clusters don't all
 * read as identically-angled facets. */
const MAX_FACING_TILT_RAD = (26 * Math.PI) / 180;

/** Multiplied into the leaf atlas texture (which already carries the base
 * green), not a standalone colour — kept close to white so the variation
 * reads as different trees catching the light differently, not as
 * different species. */
export const SUMMER_PALETTE = [0xffffff, 0xe6efd8, 0xd2e0bd, 0xf0f2e2, 0xc8d9b4];

/** Warm gold/orange/rust mix leaves are lerped toward as `autumnMix`
 * rises — picked per cluster so one tree shows a blend rather than flipping
 * uniformly. */
const AUTUMN_PALETTE = [0xd9a441, 0xc9622a, 0x9c3b2e, 0xe0b95c];

/** Corner offsets (su, sv) and matching UVs (tu, tv) for one plane's quad.
 * Hoisted to module scope rather than a literal inside the per-plane loop:
 * that literal was a fresh array-of-4-arrays allocated on every one of
 * potentially millions of plane iterations scene-wide, a real cost, not
 * just an inherent one. */
const CORNERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-1, -1, 0, 0],
  [1, -1, 1, 0],
  [1, 1, 1, 1],
  [-1, 1, 0, 1],
];

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

function clusterSize(canopyDiameterM: number): number {
  return Math.min(CLUSTER_SIZE_M, canopyDiameterM * MAX_CLUSTER_FRACTION);
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
 * @param greenPalette Summer colour pool a cluster's base tint is drawn
 *   from.
 * @param autumnMix 0 (pure `greenPalette`) to 1 (fully lerped toward
 *   `AUTUMN_PALETTE`) — pass 0 for evergreens, which don't grade (though
 *   evergreens use `needles.ts` instead of this module entirely now).
 * @param density 0 (no clusters at all) to 1 (full canopy) — the seasonal
 *   leaf-out/leaf-drop knob, see `sun.leafDensity`. One cluster is placed
 *   per selected twig — real leaf clusters sit at real twig tips, not tiled
 *   over an implicit surface — so `density` directly scales how many of
 *   `structure.twigs` get one.
 */
export function buildLeafGeometry(
  structure: TreeStructure,
  seed: number,
  canopyDiameterM: number,
  density: number,
  greenPalette: number[],
  autumnMix: number
): THREE.BufferGeometry | null {
  const random = mulberry32(seed);
  const candidates = structure.twigs;
  const targetClusters = Math.round(candidates.length * CLUSTERS_PER_TWIG * Math.max(0, Math.min(1, density)));
  // null rather than an empty BufferGeometry: an attributeless geometry
  // pushed into vegetation.ts's merge array would break `mergeGeometries`,
  // which expects every input to share the same attributes.
  if (candidates.length === 0 || targetClusters <= 0) return null;

  const order = shuffled(candidates, random);
  const size = clusterSize(canopyDiameterM);

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const outward = new THREE.Vector3();
  const facing = new THREE.Vector3();
  const tiltAxis = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const bitangent = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  const facingP = new THREE.Vector3();
  const uP = new THREE.Vector3();
  const vP = new THREE.Vector3();
  const corner = new THREE.Vector3();
  const reference = new THREE.Vector3();
  const color = new THREE.Color();
  const autumnColor = new THREE.Color();

  for (let cluster = 0; cluster < targetClusters; cluster++) {
    const twig: TwigNode = order[cluster % order.length];
    outward.copy(twig.direction);

    // Any vector not parallel to `outward` works to start the basis; picking
    // the world axis it aligns with least avoids a degenerate cross product.
    reference.set(0, 1, 0);
    if (Math.abs(outward.y) > 0.9) reference.set(1, 0, 0);
    tangent.crossVectors(outward, reference).normalize();
    bitangent.crossVectors(outward, tangent);

    // Tilt the primary plane's facing away from pure-twig-direction (see
    // MAX_FACING_TILT_RAD) — the other 2 planes are spun off this one
    // around `outward` below, so this tilt is what keeps all 3 from
    // collapsing onto an exact cone around the twig axis.
    const tiltAxisAngle = random() * Math.PI * 2;
    tiltAxis
      .copy(tangent)
      .multiplyScalar(Math.cos(tiltAxisAngle))
      .addScaledVector(bitangent, Math.sin(tiltAxisAngle));
    const tilt = (random() * 2 - 1) * MAX_FACING_TILT_RAD;
    facing.copy(outward).applyAxisAngle(tiltAxis, tilt).normalize();
    tangent.crossVectors(facing, reference).normalize();
    bitangent.crossVectors(facing, tangent);

    const roll = random() * Math.PI * 2;
    u.copy(tangent).multiplyScalar(Math.cos(roll)).addScaledVector(bitangent, Math.sin(roll));
    v.copy(tangent).multiplyScalar(-Math.sin(roll)).addScaledVector(bitangent, Math.cos(roll));

    const half = (size * (1.05 + random() * 0.5)) / 2;
    const offsetU = random();
    const offsetV = random();

    // Same tint for every plane in a cluster — one cluster is "one small
    // sprig", which plausibly shares a colour even as neighbouring sprigs
    // vary.
    color.setHex(greenPalette[Math.floor(random() * greenPalette.length)]);
    if (autumnMix > 0) {
      autumnColor.setHex(AUTUMN_PALETTE[Math.floor(random() * AUTUMN_PALETTE.length)]);
      color.lerp(autumnColor, autumnMix);
    }

    for (let plane = 0; plane < PLANES_PER_CLUSTER; plane++) {
      const angle = (plane * Math.PI * 2) / PLANES_PER_CLUSTER;
      facingP.copy(facing).applyAxisAngle(outward, angle);
      uP.copy(u).applyAxisAngle(outward, angle);
      vP.copy(v).applyAxisAngle(outward, angle);

      const base = positions.length / 3;
      for (const [su, sv, tu, tv] of CORNERS) {
        corner.copy(twig.position).addScaledVector(uP, su * half).addScaledVector(vP, sv * half);
        positions.push(corner.x, corner.y, corner.z);
        normals.push(facingP.x, facingP.y, facingP.z);
        uvs.push(offsetU + tu * FOLIAGE_UV_REPEAT, offsetV + tv * FOLIAGE_UV_REPEAT);
        colors.push(color.r, color.g, color.b);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return geometry;
}
