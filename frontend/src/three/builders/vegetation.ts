/** Trees, stumps and street furniture, drawn as instanced meshes — except
 * tree bark/leaves, which are genuinely unique per tree (see
 * `treeStructure.ts`) and so are merged into a handful of shared meshes
 * instead (see the end of `buildVegetation`).
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
import { elementYaw } from "../hash";
import { setAutumnMix, type MaterialLibrary } from "../materials";
import { loadFoliageAtlas } from "../assets";
import type { SeasonState } from "../sun";
import type { CrownForm } from "./treeStructure";
import type { BarkAttributes, FoliageAttributes, TreeJob } from "../workers/treeJobs";
import { buildTreesInWorkers, treeJobKey } from "../workers/treeWorkerPool";
import {
  buildBenchGeometry,
  buildFitnessGeometry,
  buildFountainGeometry,
  buildKioskGeometry,
  buildPergolaGeometry,
  buildPlaygroundGeometry,
  buildTrafficSignalGeometry,
} from "./furniture";

/** Fraction of total height at which the crown starts. Real broadleaf street
 * trees (plane, oak, linden...) are pruned to clear pedestrians, so their
 * crown genuinely starts a third of the way up; real conical/columnar
 * evergreens (pine, cypress) branch almost to the ground and use a much
 * smaller fraction below. The felt-temperature field puts crown bases at
 * the same heights (packs/bologna-civic-dt/bologna_civic_dt/parameters.py): keep them equal. */
const CROWN_BASE_FRACTION = 0.3;
const CROWN_BASE_FRACTION_EVERGREEN = 0.08;
const MIN_TRUNK_RADIUS_M = 0.06;
const STUMP_RADIUS_M = 0.25;

function pointPosition(anchor: GeoAnchor, element: DiscreteElement): [number, number] | null {
  if (element.geometry.type !== "Point") return null;
  const [lng, lat] = element.geometry.coordinates;
  return toLocal(anchor, lng, lat);
}

/** Fills an InstancedMesh from a list of per-instance transforms. */
function instanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  transforms: THREE.Matrix4[],
  name: string
): THREE.InstancedMesh | null {
  if (transforms.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
  transforms.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = name;
  // Instanced bounds are computed from the source geometry alone, which sits
  // at the origin — without this every instance frustum-culls as one blob.
  mesh.frustumCulled = false;
  return mesh;
}

/** Merges a list of already-world-positioned geometries (see the tree loop
 * below) into one — the tree/bark/leaf equivalent of `instanced` for
 * geometry that can't be shared via instancing because every tree's
 * structure is genuinely unique. */
function merged(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geometries.length === 0) return null;
  const geometry = mergeGeometries(geometries, false);
  if (!geometry) return null;
  releaseAfterUpload(geometry);
  return geometry;
}

/** A mesh over a tree chunk's geometry, which outlives the scene it's
 * built for (see `TreeChunk`): `disposeGroup` leaves it alone. */
function chunkMesh(geometry: THREE.BufferGeometry, material: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
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
  geometry.setIndex(new THREE.BufferAttribute(bark.index, 1));
  return geometry;
}

function foliageGeometryFromAttributes(foliage: FoliageAttributes): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(foliage.position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(foliage.normal, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(foliage.color, 3));
  if (foliage.kind === "leaf") {
    geometry.setAttribute("uv", new THREE.BufferAttribute(foliage.uv, 2));
    geometry.setAttribute("autumnColor", new THREE.BufferAttribute(foliage.autumnColor, 3));
    geometry.setAttribute("rank", new THREE.BufferAttribute(foliage.rank, 1));
    geometry.setIndex(new THREE.BufferAttribute(foliage.index, 1));
  }
  return geometry;
}

// Resolution of the leaf order (see `sortLeavesByRank`): a month's density
// is matched to 1/RANK_BUCKETS, far finer than the eye can tell.
const RANK_BUCKETS = 1024;

/** Reorders the merged leaves' triangles by their cluster `rank`, every
 * tree's together, so the leaves of any density are a prefix of the index
 * buffer: drawing a month's leaves is setting a draw range, with no new
 * geometry and nothing sent to the GPU. Returns, per bucket b, how many
 * triangles have a rank under b / RANK_BUCKETS. (A counting sort, linear in
 * the leaves.) The `rank` attribute itself is then dropped: it isn't drawn. */
function sortLeavesByRank(geometry: THREE.BufferGeometry): Uint32Array {
  const index = geometry.index!.array;
  const rank = geometry.getAttribute("rank").array;
  const triangles = index.length / 3;
  const bucketOf = new Uint16Array(triangles);
  const below = new Uint32Array(RANK_BUCKETS + 1);
  for (let t = 0; t < triangles; t++) {
    const bucket = Math.min(RANK_BUCKETS - 1, Math.floor(rank[index[t * 3]] * RANK_BUCKETS));
    bucketOf[t] = bucket;
    below[bucket + 1]++;
  }
  for (let b = 1; b <= RANK_BUCKETS; b++) below[b] += below[b - 1];
  const cursor = below.slice(0, RANK_BUCKETS);
  const sorted = new (index.constructor as Uint32ArrayConstructor)(index.length);
  for (let t = 0; t < triangles; t++) {
    const to = cursor[bucketOf[t]]++ * 3;
    sorted[to] = index[t * 3];
    sorted[to + 1] = index[t * 3 + 1];
    sorted[to + 2] = index[t * 3 + 2];
  }
  geometry.setIndex(new THREE.BufferAttribute(sorted, 1).onUpload(releaseArray));
  geometry.deleteAttribute("rank");
  return below;
}

/** The merged trees come in chunks, so that a rebuild re-merges (and sends
 * to the GPU again) only the trees that changed. A year changes about a
 * fifth of them — the ones still growing, spread all over the site — and a
 * card elsewhere none; merging every tree each time took about a second.
 *
 * Chunks are grouped by how trees change, not by place: a chunk is reused
 * whole when all its trees are unchanged, and the trees left over are packed
 * anew — growing trees (saplings, young ones, the planted ones: changed
 * every year) apart from grown ones (changed only when cut), and the ones
 * that changed this time apart from the ones that didn't. A chunk lives as long
 * as a scene drawing it (`users`): the one shown and the one being built
 * share the chunks they have in common. */
interface TreeChunk {
  keys: string[];
  bark: THREE.BufferGeometry | null;
  leaves: THREE.BufferGeometry | null;
  /** See `sortLeavesByRank`. */
  leavesBelow: Uint32Array | null;
  needles: THREE.BufferGeometry | null;
  users: number;
}

// Small enough that a cut tree invalidates few others; few enough chunks
// for the draw calls (three meshes each) not to matter.
const CHUNK_TREES = 32;

const GROWING_AGE_CLASSES = new Set(["sapling", "young"]);

/** Whether the tree still grows: its geometry changes every year. */
function isGrowing(element: DiscreteElement): boolean {
  return element.source !== "baseline" || GROWING_AGE_CLASSES.has(String(element.properties.age_class));
}

const liveChunks = new Set<TreeChunk>();

function releaseChunk(chunk: TreeChunk): void {
  if (--chunk.users > 0) return;
  liveChunks.delete(chunk);
  chunk.bark?.dispose();
  chunk.leaves?.dispose();
  chunk.needles?.dispose();
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
async function treeChunks(jobs: TreeJob[], growing: Set<string>): Promise<TreeChunk[]> {
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
  const groups = [true, false].flatMap((changed) =>
    [true, false].flatMap((grows) =>
      packed(rest.filter(({ job, key }) => known.has(key) !== changed && growing.has(job.id) === grows))
    )
  );

  const results = new Map((await buildTreesInWorkers(rest.map(({ job }) => job))).map((r) => [r.id, r]));
  for (const group of groups) {
    const bark: THREE.BufferGeometry[] = [];
    const leaves: THREE.BufferGeometry[] = [];
    const needles: THREE.BufferGeometry[] = [];
    for (const { job } of group) {
      const result = results.get(job.id);
      // A build superseded in the pool comes back empty (see
      // `buildTreesInWorkers`); its scene is dropped anyway.
      if (!result) continue;
      bark.push(barkGeometryFromAttributes(result.bark));
      if (result.foliage?.kind === "needle") needles.push(foliageGeometryFromAttributes(result.foliage));
      else if (result.foliage) leaves.push(foliageGeometryFromAttributes(result.foliage));
    }
    const leafGeometry = merged(leaves);
    chunks.push({
      keys: group.map(({ key }) => key),
      bark: merged(bark),
      leaves: leafGeometry,
      leavesBelow: leafGeometry ? sortLeavesByRank(leafGeometry) : null,
      needles: merged(needles),
      users: 0,
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
  /** Shows the trees as in `season`: leaves thinned to its density, tinted
   * by its autumn mix. Instant — nothing is rebuilt. */
  applySeason: (season: SeasonState) => void;
  /** Lets go of the tree chunks, once the scene is no longer drawn (the
   * rest of the group is disposed by `disposeGroup`). */
  release: () => void;
}

export async function buildVegetation(
  elements: DiscreteElement[],
  anchor: GeoAnchor,
  materials: MaterialLibrary
): Promise<Vegetation> {
  const broadleafAtlas = await loadFoliageAtlas();

  const group = new THREE.Group();
  group.name = "vegetation";

  const trunkGeometry = new THREE.CylinderGeometry(0.8, 1, 1, 8);
  trunkGeometry.translate(0, 0.5, 0); // base at y=0 so scale.y is the trunk length
  const stumpGeometry = new THREE.CylinderGeometry(STUMP_RADIUS_M, STUMP_RADIUS_M * 1.15, 1, 8);
  stumpGeometry.translate(0, 0.5, 0);

  const trunks: THREE.Matrix4[] = [];
  const stumps: THREE.Matrix4[] = [];
  const benches: THREE.Matrix4[] = [];
  const fountains: THREE.Matrix4[] = [];
  const kiosks: THREE.Matrix4[] = [];
  const playgrounds: THREE.Matrix4[] = [];
  const fitnessAreas: THREE.Matrix4[] = [];
  const trafficSignals: THREE.Matrix4[] = [];
  // Pergola geometry depends on the card's `size` param, so instances are
  // batched by size — same idea as the tree-crown size buckets below.
  const pergolasBySize = new Map<string, THREE.Matrix4[]>();

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

    if (element.type === "bench") {
      const yaw = elementYaw(element.id);
      benches.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, 0, z));
      continue;
    }

    if (element.type === "water_feature") {
      fountains.push(new THREE.Matrix4().setPosition(x, 0, z));
      continue;
    }

    if (element.type === "kiosk") {
      const yaw = elementYaw(element.id);
      kiosks.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, 0, z));
      continue;
    }

    if (element.type === "playground") {
      const yaw = elementYaw(element.id);
      playgrounds.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, 0, z));
      continue;
    }

    if (element.type === "fitness_area") {
      const yaw = elementYaw(element.id);
      fitnessAreas.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, 0, z));
      continue;
    }

    if (element.type === "pergola") {
      const size = String(element.properties.size ?? "medium");
      const yaw = elementYaw(element.id);
      let batch = pergolasBySize.get(size);
      if (!batch) {
        batch = [];
        pergolasBySize.set(size, batch);
      }
      batch.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, 0, z));
      continue;
    }

    // Streetlights are built separately (`builders/streetlights.ts`): each
    // needs an individual `THREE.PointLight`, not just instanced geometry.
    if (element.type === "streetlight") continue;

    if (element.type === "traffic_signal") {
      trafficSignals.push(new THREE.Matrix4().setPosition(x, 0, z));
      continue;
    }

    if (element.type !== "tree") continue;

    const height = Number(element.properties.height ?? 6);
    const canopyDiameter = Number(element.properties.canopy_diameter ?? 4);

    if (element.properties.status === "stump" || canopyDiameter <= 0) {
      stumps.push(
        new THREE.Matrix4()
          .makeScale(1, Math.max(height, 0.2), 1)
          .setPosition(x, 0, z)
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
        .setPosition(x, 0, z)
    );

    if (isGrowing(element)) growingTrees.add(element.id);
    treeJobs.push({
      id: element.id,
      x,
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
  const chunks = await treeChunks(treeJobs, growingTrees);

  const trunkMesh = instanced(trunkGeometry, materials.bark(), trunks, "tree-trunks");
  if (trunkMesh) group.add(trunkMesh);

  const foliageMaterial = materials.foliage(broadleafAtlas);
  const leafMeshes: { mesh: THREE.Mesh; below: Uint32Array }[] = [];
  for (const chunk of chunks) {
    if (chunk.bark) group.add(chunkMesh(chunk.bark, materials.bark(), "tree-bark"));
    if (chunk.leaves && chunk.leavesBelow) {
      const mesh = chunkMesh(chunk.leaves, foliageMaterial, "tree-leaves-broadleaf");
      leafMeshes.push({ mesh, below: chunk.leavesBelow });
      group.add(mesh);
    }
    if (chunk.needles) group.add(chunkMesh(chunk.needles, materials.needles(), "tree-needles"));
  }

  const stumpMesh = instanced(stumpGeometry, materials.bark(), stumps, "tree-stumps");
  if (stumpMesh) group.add(stumpMesh);

  const benchMesh = instanced(buildBenchGeometry(), materials.furniture(), benches, "benches");
  if (benchMesh) group.add(benchMesh);

  const fountainMesh = instanced(
    buildFountainGeometry(),
    materials.waterFeature(),
    fountains,
    "water-features"
  );
  if (fountainMesh) group.add(fountainMesh);

  const kioskMesh = instanced(buildKioskGeometry(), materials.kioskBody(), kiosks, "kiosks");
  if (kioskMesh) group.add(kioskMesh);

  const playgroundMesh = instanced(
    buildPlaygroundGeometry(),
    materials.playgroundEquipment(),
    playgrounds,
    "playgrounds"
  );
  if (playgroundMesh) group.add(playgroundMesh);

  const fitnessMesh = instanced(
    buildFitnessGeometry(),
    materials.fitnessEquipment(),
    fitnessAreas,
    "fitness-areas"
  );
  if (fitnessMesh) group.add(fitnessMesh);

  for (const [size, transforms] of pergolasBySize) {
    const mesh = instanced(buildPergolaGeometry(size), materials.pergolaTimber(), transforms, `pergolas-${size}`);
    if (mesh) group.add(mesh);
  }

  const trafficSignalMesh = instanced(
    buildTrafficSignalGeometry(),
    materials.trafficSignalMetal(),
    trafficSignals,
    "traffic-signals"
  );
  if (trafficSignalMesh) group.add(trafficSignalMesh);

  const applySeason = (season: SeasonState) => {
    const density = Math.max(0, Math.min(1, season.leafDensity));
    for (const { mesh, below } of leafMeshes) {
      const triangles = below[Math.round(density * RANK_BUCKETS)];
      mesh.geometry.setDrawRange(0, triangles * 3);
      mesh.visible = triangles > 0;
    }
    setAutumnMix(foliageMaterial, season.autumnMix);
  };
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const chunk of chunks) releaseChunk(chunk);
  };
  return { group, applySeason, release };
}
