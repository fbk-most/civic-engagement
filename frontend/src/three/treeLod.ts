/** A tree's detail by distance: the same tree, thinned — not another shape
 * standing in for it.
 *
 * - **Leaves**: each cluster has a `rank`, its place in a random order (see
 *   foliageCards.ts). From afar only the clusters under a share of that
 *   order are drawn, each one larger, so that the crown keeps its leaf area:
 *   the same texture, tints and lighting, so the same colour and outline.
 * - **Needles**: the same, needle by needle, each one wider (not longer).
 * - **Bark**: a branch never gets thinner on screen than a least width;
 *   past the distance where it would, fewer are drawn, in proportion, each
 *   at that width — a bare crown keeps its haze of twigs, made of fewer.
 *
 * The share is worked out for each cluster in the vertex shader, from its
 * own distance to the camera, and a cluster near the limit shrinks to
 * nothing rather than vanishing: nothing pops, and no line shows between
 * trees or tiles. The triangles are sorted (`sortTrianglesByKey`), so that
 * what a whole mesh can't show at its distance isn't sent at all (a draw
 * range).
 *
 * One number sets the foliage's, `detail` (see `treeLodSettings`): how
 * small, in pixels, a leaf cluster or a needle may get before thinning
 * starts. A tree's triangles then follow the area it takes on screen.
 */

import * as THREE from "three";

/** How a tree's leaves, or needles, thin with distance. */
export interface FoliageLod {
  /** Up to this distance (m) all of it is drawn. */
  d0: number;
  /** Beyond it the share drawn is (d0 / distance) ** exponent: 2 keeps a
   * card's size on screen, 1 a needle's width. */
  exponent: number;
  /** The share never goes under this: a tree keeps a crown. */
  floor: number;
  /** What's drawn is scaled by share ** -growExponent: 0.5 keeps the area
   * of cards scaled both ways, 1 that of needles scaled in width. */
  growExponent: number;
  /** ... and by no more than this, so that a crown doesn't swell. */
  maxGrow: number;
}

export interface TreeLodSettings {
  leaves: FoliageLod;
  needles: FoliageLod;
  /** The least radius a branch is drawn with is the distance times this;
   * of the thinner ones, the share drawn is their radius over that. */
  barkSlope: number;
  /** ... and never under this (m): 0 for the view; for a shadow, what its
   * map can show. */
  barkFloor: number;
}

/** The clusters whose rank is within this share over the limit are drawn,
 * shrinking to nothing at its end: what makes thinning smooth. */
export const LOD_FADE = 0.25;

// The size of what is thinned, in metres: a leaf cluster's side (see
// foliageCards.ts: CLUSTER_SIZE_M, times its mean random factor) and a
// needle's width (needles.ts).
const LEAF_CLUSTER_M = 0.55;
const NEEDLE_WIDTH_M = 0.02;
// At detail 1, the size on screen (pixels) under which thinning starts.
const LEAF_PX = 6;
const NEEDLE_PX = 1;
// The least width on screen (pixels) a branch is drawn with.
const BARK_PX = 1;

/** The pixels a metre takes at a distance of 1 m, for a view `heightPx`
 * high: what turns sizes on screen into distances. */
export function pixelsPerMetre(fovDeg: number, heightPx: number): number {
  return heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
}

/** The thinning for a `detail` (1: the default; 2: things may get half as
 * small on screen before they thin; 0.5: twice as large) and a view. */
export function treeLodSettings(detail: number, pxPerM: number, tuning?: Partial<Pick<FoliageLod, "floor" | "growExponent" | "maxGrow">> & { barkPx?: number }): TreeLodSettings {
  return {
    leaves: {
      d0: (LEAF_CLUSTER_M * pxPerM * detail) / LEAF_PX,
      exponent: 2,
      floor: tuning?.floor ?? 0.03,
      growExponent: tuning?.growExponent ?? 0.5,
      maxGrow: tuning?.maxGrow ?? 4,
    },
    needles: {
      d0: (NEEDLE_WIDTH_M * pxPerM * detail) / NEEDLE_PX,
      exponent: 1,
      floor: tuning?.floor ?? 0.03,
      growExponent: 1,
      maxGrow: 1 / (tuning?.floor ?? 0.03),
    },
    // Not by `detail`: what a thin line on screen looks like is the same
    // whatever the machine.
    barkSlope: (tuning?.barkPx ?? BARK_PX) / (2 * pxPerM),
    barkFloor: 0,
  };
}

/** The least width (pixels) of a branch by the season's leaf density: a
 * bare crown is its twigs, so they stay fine; a crown in leaf hides most of
 * them. (Judged in the tree detail lab, `treeLodLab.ts`.) */
export function barkPxFor(leafDensity: number): number {
  if (leafDensity <= 0.1) return 0.5 + (leafDensity / 0.1) * 0.5;
  return 1 + Math.min(1, (leafDensity - 0.1) / 0.4);
}

/** The share of a tree's foliage drawn at `distance`. */
export function keptShare(lod: FoliageLod, distance: number): number {
  return Math.max(lod.floor, Math.min(1, (lod.d0 / Math.max(distance, 1e-3)) ** lod.exponent));
}

/* ---- The triangles' order ---- */

/** Resolution of the orders below: finer than the eye can tell. */
export const LOD_BUCKETS = 1024;

/** A rank's bucket: the lowest ranks first. */
export function rankBucket(rank: number): number {
  return Math.min(LOD_BUCKETS - 1, Math.max(0, Math.floor(rank * LOD_BUCKETS)));
}

const RADIUS_MIN_M = 0.004;
const RADIUS_MAX_M = 200;

/** A branch's place in the bark's order: its radius over its rank, in
 * metres — the larger, the further it is drawn from (see `barkTriangles`). */
export function barkReach(radius: number, rank: number): number {
  return radius / Math.max(rank, 1e-4);
}

/** A radius's (or a reach's) bucket: the largest first, on a log scale. */
export function radiusBucket(radius: number): number {
  const share = Math.log(Math.max(radius, RADIUS_MIN_M) / RADIUS_MIN_M) / Math.log(RADIUS_MAX_M / RADIUS_MIN_M);
  return Math.min(LOD_BUCKETS - 1, Math.max(0, Math.floor((1 - share) * LOD_BUCKETS)));
}

/** Reorders `geometry`'s triangles by the bucket of their first vertex
 * (`bucketOf` takes its index), so that the triangles of the first buckets are a prefix of
 * the index: drawing fewer of them is setting a draw range, with nothing
 * rebuilt or sent again. Returns, per bucket b, how many triangles are in
 * the buckets under b. (A counting sort, linear in the triangles; a
 * geometry without an index gets one.) */
export function sortTrianglesByKey(geometry: THREE.BufferGeometry, bucketOf: (vertex: number) => number): Uint32Array {
  const vertices = geometry.getAttribute("position").count;
  const index = geometry.index?.array ?? null;
  const triangles = (index ? index.length : vertices) / 3;
  const bucket = new Uint16Array(triangles);
  const below = new Uint32Array(LOD_BUCKETS + 1);
  for (let t = 0; t < triangles; t++) {
    const b = bucketOf(index ? index[t * 3] : t * 3);
    bucket[t] = b;
    below[b + 1]++;
  }
  for (let b = 1; b <= LOD_BUCKETS; b++) below[b] += below[b - 1];
  const cursor = below.slice(0, LOD_BUCKETS);
  const sorted = vertices > 65535 ? new Uint32Array(triangles * 3) : new Uint16Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    const to = cursor[bucket[t]]++ * 3;
    sorted[to] = index ? index[t * 3] : t * 3;
    sorted[to + 1] = index ? index[t * 3 + 1] : t * 3 + 1;
    sorted[to + 2] = index ? index[t * 3 + 2] : t * 3 + 2;
  }
  geometry.setIndex(new THREE.BufferAttribute(sorted, 1));
  return below;
}

/** How many of a foliage mesh's sorted triangles to send, the nearest of it
 * being at `nearest` from the camera and the season showing `density` of
 * its leaves: all those the shader may still draw. */
export function foliageTriangles(below: Uint32Array, lod: FoliageLod, nearest: number, density = 1): number {
  const limit = density * keptShare(lod, nearest) * (1 + LOD_FADE);
  return below[Math.min(LOD_BUCKETS, Math.ceil(limit * LOD_BUCKETS))];
}

/** The orders to sort a tree mesh's triangles in (`sortTrianglesByKey`). */
export function foliageOrder(geometry: THREE.BufferGeometry): (vertex: number) => number {
  const rank = geometry.getAttribute("rank").array;
  return (vertex) => rankBucket(rank[vertex]);
}

export function barkOrder(geometry: THREE.BufferGeometry): (vertex: number) => number {
  const radius = geometry.getAttribute("radius").array;
  const rank = geometry.getAttribute("rank").array;
  return (vertex) => radiusBucket(barkReach(radius[vertex], rank[vertex]));
}

/** The same for a bark mesh, sorted by `barkOrder`: a branch is drawn while
 * its rank is under its radius over the least one, so while its reach is
 * over that least radius (less the fade). */
export function barkTriangles(below: Uint32Array, settings: Pick<TreeLodSettings, "barkSlope" | "barkFloor">, nearest: number): number {
  return below[radiusBucket(Math.max(nearest * settings.barkSlope, settings.barkFloor) / (1 + LOD_FADE)) + 1];
}

/* ---- The materials ---- */

export interface TreeLodUniforms {
  /** The camera of the view (not a shadow's or a reflection's), in the
   * world: shared by a scene's tree materials. */
  lodEye: { value: THREE.Vector3 };
  /** Foliage: d0, exponent, floor, and the season's leaf density. */
  lodCurve: { value: THREE.Vector4 };
  /** Foliage: growExponent, maxGrow. Bark: its slope and its floor. */
  lodShape: { value: THREE.Vector2 };
}

export function treeLodUniforms(eye: { value: THREE.Vector3 }): TreeLodUniforms {
  // Off until set: everything drawn, at its own size.
  return { lodEye: eye, lodCurve: { value: new THREE.Vector4(1e9, 1, 1, 1) }, lodShape: { value: new THREE.Vector2(0, 1) } };
}

export function setFoliageLod(uniforms: TreeLodUniforms, lod: FoliageLod, density = 1): void {
  uniforms.lodCurve.value.set(lod.d0, lod.exponent, lod.floor, density);
  uniforms.lodShape.value.set(lod.growExponent, lod.maxGrow);
}

export function setBarkLod(uniforms: TreeLodUniforms, settings: Pick<TreeLodSettings, "barkSlope" | "barkFloor">): void {
  uniforms.lodShape.value.set(settings.barkSlope, settings.barkFloor);
}

const FOLIAGE_PARS = [
  "attribute vec3 center;",
  "attribute float rank;",
  "uniform vec3 lodEye;",
  "uniform vec4 lodCurve;",
  "uniform vec2 lodShape;",
].join("\n");

// `center` is what a vertex is scaled about: a leaf cluster's twig, a
// needle's foot (and, for its tip, the tip itself: a needle only widens).
const FOLIAGE_VERTEX = [
  "  float lodDistance = distance((modelMatrix * vec4(center, 1.0)).xyz, lodEye);",
  "  float lodKept = clamp(pow(lodCurve.x / max(lodDistance, 0.001), lodCurve.y), lodCurve.z, 1.0);",
  "  float lodLimit = lodKept * lodCurve.w;",
  `  float lodScale = min(pow(lodKept, -lodShape.x), lodShape.y) * (1.0 - smoothstep(lodLimit, lodLimit * ${(1 + LOD_FADE).toFixed(3)}, rank));`,
  "  transformed = center + (transformed - center) * lodScale;",
].join("\n");

const BARK_PARS = ["attribute vec3 center;", "attribute float radius;", "attribute float rank;", "uniform vec3 lodEye;", "uniform vec2 lodShape;"].join("\n");

// `center` is the branch's axis at the vertex's ring: a branch is widened
// about it to the least width, or closed onto it when it's left out.
const BARK_VERTEX = [
  "  float lodDistance = distance((modelMatrix * vec4(center, 1.0)).xyz, lodEye);",
  "  float lodLeast = max(lodDistance * lodShape.x, lodShape.y);",
  "  float lodKept = lodLeast > 0.0 ? min(1.0, radius / lodLeast) : 1.0;",
  `  float lodScale = (1.0 - smoothstep(lodKept, lodKept * ${(1 + LOD_FADE).toFixed(3)}, rank)) / lodKept;`,
  "  transformed = center + (transformed - center) * lodScale;",
].join("\n");

function withLod<M extends THREE.Material>(material: M, uniforms: TreeLodUniforms, pars: string, vertex: string, key: string): M {
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${pars}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${vertex}`);
  };
  material.customProgramCacheKey = () => `${previousKey()}|${key}`;
  return material;
}

/** Makes `material` thin the leaves or needles it draws (their geometry
 * needs `center` and `rank`), as `uniforms` say. */
export function withFoliageLod<M extends THREE.Material>(material: M, uniforms: TreeLodUniforms): M {
  return withLod(material, uniforms, FOLIAGE_PARS, FOLIAGE_VERTEX, "foliage-lod");
}

/** Makes `material` thin the branches too thin for their distance
 * (their geometry needs `center`, `radius` and `rank`). */
export function withBarkLod<M extends THREE.Material>(material: M, uniforms: TreeLodUniforms): M {
  return withLod(material, uniforms, BARK_PARS, BARK_VERTEX, "bark-lod");
}

/* ---- A scene's trees ---- */

/** How much coarser than the view the trees are in a shadow: a shadow's
 * own detail is lost in its softness. */
const SHADOW_DETAIL = 0.5;
const SHADOW_BARK = 2;

/** How far (m) thinning can move a vertex out of its mesh's bounds: a leaf
 * card grown to the most. */
export const LOD_MARGIN_M = 2.5;

type DepthMaterials = { depth: THREE.MeshDepthMaterial; distance: THREE.MeshDistanceMaterial };

/** What a scene's tree materials share (see `MaterialLibrary.treeLod`):
 * the uniforms of the view's materials and of the shadows' — the shadow of
 * a thinned tree is cast by the same thinned tree, a little coarser — and
 * what the viewer knows that sets them. */
export interface TreeLod {
  eye: { value: THREE.Vector3 };
  leaves: TreeLodUniforms;
  needles: TreeLodUniforms;
  bark: TreeLodUniforms;
  shadowLeaves: TreeLodUniforms;
  shadowNeedles: TreeLodUniforms;
  shadowBark: TreeLodUniforms;
  /** For the meshes' `customDepthMaterial` and `customDistanceMaterial`. */
  leafShadow: DepthMaterials;
  needleShadow: DepthMaterials;
  barkShadow: DepthMaterials;
  /** The drawing buffer's height (pixels): the viewer's to set. */
  viewHeightPx: number;
  /** The side of a texel of the sun's shadow map (m): the viewer's to set. */
  shadowTexelM: number;
}

export function createTreeLod(): TreeLod {
  const eye = { value: new THREE.Vector3() };
  const bark = () => {
    const uniforms = treeLodUniforms(eye);
    uniforms.lodShape.value.set(0, 0);
    return uniforms;
  };
  const shadowLeaves = treeLodUniforms(eye);
  const shadowNeedles = treeLodUniforms(eye);
  const shadowBark = bark();
  const shadow = (uniforms: TreeLodUniforms, patch: typeof withFoliageLod): DepthMaterials => ({
    depth: patch(new THREE.MeshDepthMaterial(), uniforms),
    distance: patch(new THREE.MeshDistanceMaterial(), uniforms),
  });
  return {
    eye,
    leaves: treeLodUniforms(eye),
    needles: treeLodUniforms(eye),
    bark: bark(),
    shadowLeaves,
    shadowNeedles,
    shadowBark,
    leafShadow: shadow(shadowLeaves, withFoliageLod),
    needleShadow: shadow(shadowNeedles, withFoliageLod),
    barkShadow: shadow(shadowBark, withBarkLod),
    viewHeightPx: 1000,
    shadowTexelM: 0.1,
  };
}

export function disposeTreeLod(lod: TreeLod): void {
  for (const materials of [lod.leafShadow, lod.needleShadow, lod.barkShadow]) {
    materials.depth.dispose();
    materials.distance.dispose();
  }
}

/** Sets the trees' thinning for this frame's `camera`, a `detail` and the
 * season's leaf density, and returns it: for the view and for the shadows. */
export function updateTreeLod(lod: TreeLod, camera: THREE.Camera, detail: number, leafDensity: number): { view: TreeLodSettings; shadow: TreeLodSettings } {
  lod.eye.value.setFromMatrixPosition(camera.matrixWorld);
  const perspective = camera as THREE.PerspectiveCamera;
  const pxPerM = perspective.isPerspectiveCamera ? pixelsPerMetre(perspective.fov, lod.viewHeightPx) * perspective.zoom : lod.viewHeightPx / 100;
  const view = treeLodSettings(detail, pxPerM, { barkPx: barkPxFor(leafDensity) });
  const shadow = treeLodSettings(detail * SHADOW_DETAIL, pxPerM);
  // A branch thinner than a texel of the shadow map casts nothing sharper
  // than one a texel wide: fewer of them, that wide.
  shadow.barkSlope = view.barkSlope * SHADOW_BARK;
  shadow.barkFloor = lod.shadowTexelM / 2;
  setFoliageLod(lod.leaves, view.leaves, leafDensity);
  setFoliageLod(lod.needles, view.needles);
  setBarkLod(lod.bark, view);
  setFoliageLod(lod.shadowLeaves, shadow.leaves, leafDensity);
  setFoliageLod(lod.shadowNeedles, shadow.needles);
  setBarkLod(lod.shadowBark, shadow);
  return { view, shadow };
}
