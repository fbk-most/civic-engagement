/** Trees and stumps, drawn as instanced meshes — except tree bark/leaves,
 * which are genuinely unique per tree (see `treeStructure.ts`) and so are
 * merged into a handful of shared meshes instead (see the end of
 * `buildVegetation`). Other things standing on the ground (the urban pack's
 * furniture, say) are the pack's own scene parts (see three/parts.ts).
 *
 * Every per-instance transform is driven by the model's own `canopy_diameter`
 * and `height` (see `bologna_civic_dt/model.py`), which is what makes the scenario time
 * slider work in 3D for free: growing a tree is just a larger scale on the
 * same instance, and felling one swaps it into the stump batch.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { DiscreteElement } from "../../api/types";
import { toLocal, type GeoAnchor } from "../geo";
import { instanced } from "../instancing";
import { setAutumnMix, type MaterialLibrary } from "../materials";
import { loadFoliageAtlas } from "../assets";
import type { SeasonState } from "../sun";
import type { Terrain } from "../terrain";
import type { CrownForm } from "./treeStructure";
import type { BarkAttributes, FoliageAttributes, TreeJob } from "../workers/treeJobs";
import { treeJobKey, type TreeWorkerPool } from "../workers/treeWorkerPool";
import type { ViewContext } from "../viewSettings";
import {
  barkOrder,
  barkTriangles,
  foliageOrder,
  foliageTriangles,
  LOD_BUCKETS,
  LOD_MARGIN_M,
  sortTrianglesByKey,
  updateTreeLod,
  type TreeLodSettings,
} from "../treeLod";

/** Fraction of total height at which the crown starts. Real broadleaf street
 * trees (plane, oak, linden...) are pruned to clear pedestrians, so their
 * crown genuinely starts a third of the way up; real conical/columnar
 * evergreens (pine, cypress) branch almost to the ground and use a much
 * smaller fraction below. The felt-temperature field puts crown bases at
 * the same heights (bologna-civic-dt's bologna_civic_dt/parameters.py): keep them equal. */
const CROWN_BASE_FRACTION = 0.3;
const CROWN_BASE_FRACTION_EVERGREEN = 0.08;
const MIN_TRUNK_RADIUS_M = 0.06;
const STUMP_RADIUS_M = 0.25;

function pointPosition(anchor: GeoAnchor, element: DiscreteElement): [number, number] | null {
  if (element.geometry.type !== "Point") return null;
  const [lng, lat] = element.geometry.coordinates;
  return toLocal(anchor, lng, lat);
}

/** Merges a list of already-world-positioned geometries (see the tree loop
 * below) into one — the tree/bark/leaf equivalent of `instanced` for
 * geometry that can't be shared via instancing because every tree's
 * structure is genuinely unique. */
function merged(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geometries.length === 0) return null;
  return mergeGeometries(geometries, false);
}

/** A chunk's merged geometry with its triangles in the order they are left
 * out by from afar (see `treeLod.ts`), and how many each step of that order
 * holds. */
interface Sorted {
  geometry: THREE.BufferGeometry;
  below: Uint32Array;
}

function sorted(geometry: THREE.BufferGeometry | null, order: (geometry: THREE.BufferGeometry) => (vertex: number) => number): Sorted | null {
  if (!geometry) return null;
  const below = sortTrianglesByKey(geometry, order(geometry));
  releaseAfterUpload(geometry);
  return { geometry, below };
}

/** A mesh over a tree chunk's geometry, which outlives the scene it's
 * built for (see `TreeChunk`): `disposeGroup` leaves it alone. Its shadow
 * is cast by `shadow`'s materials, which thin it as the view's do. */
function chunkMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  shadow: { depth: THREE.Material; distance: THREE.Material },
  name: string
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.customDepthMaterial = shadow.depth;
  mesh.customDistanceMaterial = shadow.distance;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = name;
  mesh.userData.sharedGeometry = true;
  return mesh;
}

/** Frees the merged trees' arrays once they're on the GPU: hundreds of MB
 * that nothing reads again — the trees are never picked or re-measured, and
 * a season only changes the draw range (see `applySeason`). The bounds the
 * renderer needs for culling are computed first, while the arrays are
 * there. (The per-tree arrays stay in the worker pool's cache.) */
function releaseAfterUpload(geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  // Thinning moves vertices a little out of where they were built.
  geometry.boundingSphere!.radius += LOD_MARGIN_M;
  geometry.boundingBox!.expandByScalar(LOD_MARGIN_M);
  for (const attribute of Object.values(geometry.attributes)) (attribute as THREE.BufferAttribute).onUpload(releaseArray);
  geometry.index?.onUpload(releaseArray);
}

function releaseArray(this: THREE.BufferAttribute): void {
  (this as unknown as { array: null }).array = null;
}

/** Rebuilds one tree's bark/foliage `BufferGeometry` from the typed arrays a
 * worker (`treeWorkerPool.ts`) sent back — every array is already
 * world-translated, so this is pure attribute-wrapping, no math. Uses the
 * base `THREE.BufferAttribute` rather than `Float32BufferAttribute`, whose
 * constructor does `new Float32Array(array)` and would silently copy
 * instead of reusing the transferred buffer. */
function barkGeometryFromAttributes(bark: BarkAttributes): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(bark.position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(bark.normal, 3));
  geometry.setAttribute("center", new THREE.BufferAttribute(bark.center, 3));
  geometry.setAttribute("radius", new THREE.BufferAttribute(bark.radius, 1));
  geometry.setAttribute("rank", new THREE.BufferAttribute(bark.rank, 1));
  geometry.setIndex(new THREE.BufferAttribute(bark.index, 1));
  return geometry;
}

function foliageGeometryFromAttributes(foliage: FoliageAttributes): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(foliage.position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(foliage.normal, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(foliage.color, 3));
  geometry.setAttribute("rank", new THREE.BufferAttribute(foliage.rank, 1));
  geometry.setAttribute("center", new THREE.BufferAttribute(foliage.center, 3));
  if (foliage.kind === "leaf") {
    geometry.setAttribute("uv", new THREE.BufferAttribute(foliage.uv, 2));
    geometry.setAttribute("autumnColor", new THREE.BufferAttribute(foliage.autumnColor, 3));
    geometry.setIndex(new THREE.BufferAttribute(foliage.index, 1));
  }
  return geometry;
}

/** The merged trees come in chunks, so that a rebuild re-merges (and sends
 * to the GPU again) only the trees that changed. A year changes about a
 * fifth of them — the ones still growing, spread all over the site — and a
 * card elsewhere none; merging every tree each time took about a second.
 *
 * Chunks are grouped by how trees change and by place: a chunk is reused
 * whole when all its trees are unchanged, and the trees left over are packed
 * anew — growing trees (saplings, young ones, the planted ones: changed
 * every year) apart from grown ones (changed only when cut), the ones that
 * changed this time apart from the ones that didn't, and tile by tile, so
 * that a chunk's distance to the camera says how much of it to send (see
 * `frame`). A chunk lives as long as a scene drawing it (`users`): the one
 * shown and the one being built share the chunks they have in common. */
interface TreeChunk {
  keys: string[];
  /** Its trees' extent, crowns included. */
  box: THREE.Box3;
  bark: Sorted | null;
  leaves: Sorted | null;
  needles: Sorted | null;
  users: number;
  /** The view's live chunks it's among (see `liveChunksOf`). */
  live: Set<TreeChunk>;
}

// A tile of trees: small enough for its distance to the camera to be near
// each of its trees'.
const TILE_M = 30;

function tileKey(job: TreeJob): string {
  return `${Math.floor(job.x / TILE_M)},${Math.floor(job.z / TILE_M)}`;
}

// Small enough that a cut tree invalidates few others; few enough chunks
// for the draw calls (three meshes each) not to matter.
const CHUNK_TREES = 32;

const GROWING_AGE_CLASSES = new Set(["sapling", "young"]);

/** Whether the tree still grows: its geometry changes every year. */
function isGrowing(element: DiscreteElement): boolean {
  return element.source !== "baseline" || GROWING_AGE_CLASSES.has(String(element.properties.age_class));
}

// Each view's own chunks, by its pool of tree workers (one per view): a
// chunk's arrays are freed once uploaded to the view's WebGL context (see
// `releaseAfterUpload`), so another view, with a context of its own, could
// never upload it.
const liveChunksByView = new WeakMap<TreeWorkerPool, Set<TreeChunk>>();

function liveChunksOf(pool: TreeWorkerPool): Set<TreeChunk> {
  let live = liveChunksByView.get(pool);
  if (!live) liveChunksByView.set(pool, (live = new Set()));
  return live;
}

function releaseChunk(chunk: TreeChunk): void {
  if (--chunk.users > 0) return;
  chunk.live.delete(chunk);
  chunk.bark?.geometry.dispose();
  chunk.leaves?.geometry.dispose();
  chunk.needles?.geometry.dispose();
}

/** Splits `jobs` into chunks of at most CHUNK_TREES, in a stable order. */
function packed(jobs: { job: TreeJob; key: string }[]): { job: TreeJob; key: string }[][] {
  const sorted = [...jobs].sort((a, b) => (a.job.id < b.job.id ? -1 : a.job.id > b.job.id ? 1 : 0));
  const groups = [];
  for (let i = 0; i < sorted.length; i += CHUNK_TREES) groups.push(sorted.slice(i, i + CHUNK_TREES));
  return groups;
}

/** The chunks drawing `jobs`: the live ones that still fit, and new ones,
 * built (in the worker pool) and merged, for the rest. */
async function treeChunks(jobs: TreeJob[], growing: Set<string>, pool: TreeWorkerPool): Promise<TreeChunk[]> {
  const liveChunks = liveChunksOf(pool);
  const wanted = new Map(jobs.map((job) => [treeJobKey(job), job]));
  const known = new Set<string>();
  const chunks: TreeChunk[] = [];
  for (const chunk of liveChunks) {
    for (const key of chunk.keys) known.add(key);
    if (chunk.keys.every((key) => wanted.has(key))) {
      for (const key of chunk.keys) wanted.delete(key);
      chunks.push(chunk);
    }
  }
  const rest = [...wanted].map(([key, job]) => ({ job, key }));
  const tiles = new Set(rest.map(({ job }) => tileKey(job)));
  const groups = [...tiles].flatMap((tile) =>
    [true, false].flatMap((changed) =>
      [true, false].flatMap((grows) =>
        packed(rest.filter(({ job, key }) => tileKey(job) === tile && known.has(key) !== changed && growing.has(job.id) === grows))
      )
    )
  );

  const results = new Map((await pool.build(rest.map(({ job }) => job))).map((r) => [r.id, r]));
  for (const group of groups) {
    const bark: THREE.BufferGeometry[] = [];
    const leaves: THREE.BufferGeometry[] = [];
    const needles: THREE.BufferGeometry[] = [];
    const box = new THREE.Box3();
    for (const { job } of group) {
      const result = results.get(job.id);
      // A build superseded in the pool comes back empty (see
      // `TreeWorkerPool.build`); its scene is dropped anyway.
      if (!result) continue;
      bark.push(barkGeometryFromAttributes(result.bark));
      if (result.foliage?.kind === "needle") needles.push(foliageGeometryFromAttributes(result.foliage));
      else if (result.foliage) leaves.push(foliageGeometryFromAttributes(result.foliage));
      const reach = job.canopyDiameter / 2;
      box.expandByPoint(new THREE.Vector3(job.x - reach, job.y, job.z - reach));
      box.expandByPoint(new THREE.Vector3(job.x + reach, job.y + job.height, job.z + reach));
    }
    chunks.push({
      keys: group.map(({ key }) => key),
      box,
      bark: sorted(merged(bark), barkOrder),
      leaves: sorted(merged(leaves), foliageOrder),
      needles: sorted(merged(needles), foliageOrder),
      users: 0,
      live: liveChunks,
    });
  }
  const complete = groups.every((group) => group.every(({ job }) => results.has(job.id)));
  for (const chunk of chunks) {
    chunk.users++;
    if (complete) liveChunks.add(chunk);
  }
  return chunks;
}

export interface Vegetation {
  group: THREE.Group;
  /** Every frame: sets the trees' detail for the camera (see `treeLod.ts`)
   * and, when it has moved, how much of each chunk is sent. */
  frame: (camera: THREE.Camera) => void;
  /** Shows the trees as in `season`: leaves thinned to its density, tinted
   * by its autumn mix. Instant — nothing is rebuilt. */
  applySeason: (season: SeasonState) => void;
  /** Lets go of the tree chunks, once the scene is no longer drawn (the
   * rest of the group is disposed by `disposeGroup`). */
  release: () => void;
}

// The camera moves this much before the chunks' draw ranges are set again;
// they are set for a camera that much nearer, so that they hold meanwhile.
const RECHECK_M = 3;

/** A chunk mesh and how much of it to send. */
interface Thinned {
  mesh: THREE.Mesh;
  below: Uint32Array;
  box: THREE.Box3;
  /** The triangles to send for the view and for a shadow. */
  count: (settings: TreeLodSettings, nearest: number, density: number) => number;
  view: number;
  shadow: number;
}

function thinned(mesh: THREE.Mesh, part: Sorted, box: THREE.Box3, count: Thinned["count"]): Thinned {
  const item: Thinned = { mesh, below: part.below, box, count, view: part.below[LOD_BUCKETS], shadow: part.below[LOD_BUCKETS] };
  // A shadow is cast by fewer triangles than the view draws (the geometry
  // is the chunk's, shared: the range is put back after).
  mesh.onBeforeShadow = () => mesh.geometry.setDrawRange(0, item.shadow * 3);
  mesh.onAfterShadow = () => mesh.geometry.setDrawRange(0, item.view * 3);
  return item;
}

export async function buildVegetation(
  elements: DiscreteElement[],
  anchor: GeoAnchor,
  materials: MaterialLibrary,
  terrain: Terrain,
  view: ViewContext
): Promise<Vegetation> {
  // How fine the trees stay with distance (see `treeLod.ts`): the view's.
  const detail = view.settings.treeDetail;
  const broadleafAtlas = await loadFoliageAtlas();

  const group = new THREE.Group();
  group.name = "vegetation";

  const trunkGeometry = new THREE.CylinderGeometry(0.8, 1, 1, 8);
  trunkGeometry.translate(0, 0.5, 0); // base at y=0 so scale.y is the trunk length
  const stumpGeometry = new THREE.CylinderGeometry(STUMP_RADIUS_M, STUMP_RADIUS_M * 1.15, 1, 8);
  stumpGeometry.translate(0, 0.5, 0);

  const trunks: THREE.Matrix4[] = [];
  const stumps: THREE.Matrix4[] = [];

  // Every tree's bark and leaves are geometrically unique (grown from its
  // own seed/height/diameter — see treeStructure.ts) so, like the old
  // bare-winter branch mesh, they can't be instanced. Each tree's geometry
  // is translated to its world position, then merged with others into a
  // bark, a broadleaf and a needle mesh per chunk (see `TreeChunk`),
  // instead of hundreds of individual draw calls.
  const treeJobs: TreeJob[] = [];
  const growingTrees = new Set<string>();

  for (const element of elements) {
    const position = pointPosition(anchor, element);
    if (!position) continue;
    const [x, z] = position;

    if (element.type !== "tree") continue;
    const y = terrain.heightAt(x, z);

    const height = Number(element.properties.height ?? 6);
    const canopyDiameter = Number(element.properties.canopy_diameter ?? 4);

    if (element.properties.status === "stump" || canopyDiameter <= 0) {
      stumps.push(
        new THREE.Matrix4()
          .makeScale(1, Math.max(height, 0.2), 1)
          .setPosition(x, y, z)
      );
      continue;
    }

    const crownForm = (element.properties.crown_form as CrownForm | undefined) ?? "round";
    // Evergreens ignore the season entirely — always full, never graded.
    const isEvergreen = element.properties.foliage_type === "evergreen";

    const crownBaseFraction = isEvergreen ? CROWN_BASE_FRACTION_EVERGREEN : CROWN_BASE_FRACTION;
    const trunkTop = Math.max(height * crownBaseFraction, 0.3);
    const trunkRadius = Math.max(canopyDiameter / 20, MIN_TRUNK_RADIUS_M);

    trunks.push(
      new THREE.Matrix4()
        .makeScale(trunkRadius, trunkTop, trunkRadius)
        .setPosition(x, y, z)
    );

    if (isGrowing(element)) growingTrees.add(element.id);
    treeJobs.push({
      id: element.id,
      x,
      y,
      z,
      trunkTop,
      height,
      canopyDiameter,
      crownForm,
      isEvergreen,
    });
  }

  // Every tree's structure/bark/foliage generation is pure per-tree math
  // with no cross-tree dependency (see `workers/treeWorker.ts`), so it runs
  // across a worker pool rather than inline here — see
  // `workers/treeWorkerPool.ts` for why (measured ~1.7-1.8s of this
  // function's own wall-clock time otherwise, ~62% of it in foliage alone).
  const chunks = await treeChunks(treeJobs, growingTrees, view.trees);

  const trunkMesh = instanced(trunkGeometry, materials.bark(), trunks, "tree-trunks");
  if (trunkMesh) group.add(trunkMesh);

  const foliageMaterial = materials.foliage(broadleafAtlas);
  const lod = materials.treeLod;
  const meshes: Thinned[] = [];
  const add = (item: Thinned) => {
    meshes.push(item);
    group.add(item.mesh);
  };
  for (const chunk of chunks) {
    if (chunk.bark) {
      const mesh = chunkMesh(chunk.bark.geometry, materials.branches(), lod.barkShadow, "tree-bark");
      add(thinned(mesh, chunk.bark, chunk.box, (settings, nearest) => barkTriangles(chunk.bark!.below, settings, nearest)));
    }
    if (chunk.leaves) {
      const mesh = chunkMesh(chunk.leaves.geometry, foliageMaterial, lod.leafShadow, "tree-leaves-broadleaf");
      add(thinned(mesh, chunk.leaves, chunk.box, (settings, nearest, density) => foliageTriangles(chunk.leaves!.below, settings.leaves, nearest, density)));
    }
    if (chunk.needles) {
      const mesh = chunkMesh(chunk.needles.geometry, materials.needles(), lod.needleShadow, "tree-needles");
      add(thinned(mesh, chunk.needles, chunk.box, (settings, nearest) => foliageTriangles(chunk.needles!.below, settings.needles, nearest)));
    }
  }

  const stumpMesh = instanced(stumpGeometry, materials.bark(), stumps, "tree-stumps");
  if (stumpMesh) group.add(stumpMesh);

  let leafDensity = 1;
  // What the draw ranges were last set for: the camera's place, and the
  // rest of what they depend on (the view's scale, the season).
  const setAt = new THREE.Vector3(Infinity, Infinity, Infinity);
  let setFor = "";
  const frame = (camera: THREE.Camera) => {
    const { view, shadow } = updateTreeLod(lod, camera, detail, leafDensity);
    const state = `${view.leaves.d0}|${view.barkSlope}|${shadow.barkFloor}|${leafDensity}`;
    if (state === setFor && lod.eye.value.distanceTo(setAt) < RECHECK_M) return;
    setFor = state;
    setAt.copy(lod.eye.value);
    for (const item of meshes) {
      const nearest = Math.max(0, item.box.distanceToPoint(setAt) - RECHECK_M);
      item.view = item.count(view, nearest, leafDensity);
      // Never more than the view's: the range isn't swapped for the pond's
      // reflection, which draws the view's.
      item.shadow = Math.min(item.view, item.count(shadow, nearest, leafDensity));
      item.mesh.geometry.setDrawRange(0, item.view * 3);
      item.mesh.visible = item.view > 0;
    }
  };

  const applySeason = (season: SeasonState) => {
    leafDensity = Math.max(0, Math.min(1, season.leafDensity));
    setAutumnMix(foliageMaterial, season.autumnMix);
  };
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const chunk of chunks) releaseChunk(chunk);
  };
  return { group, frame, applySeason, release };
}
