/** Trees, stumps and street furniture, drawn as instanced meshes — except
 * tree bark/leaves, which are genuinely unique per tree (see
 * `treeStructure.ts`) and so are merged into a handful of shared meshes
 * instead (see the end of `buildVegetation`).
 *
 * Every per-instance transform is driven by the model's own `canopy_diameter`
 * and `height` (see `domains/urban/model.py`), which is what makes the scenario time
 * slider work in 3D for free: growing a tree is just a larger scale on the
 * same instance, and felling one swaps it into the stump batch.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { DiscreteElement } from "../../api/types";
import { toLocal, type GeoAnchor } from "../geo";
import { elementYaw } from "../hash";
import type { MaterialLibrary } from "../materials";
import { loadFoliageAtlas } from "../assets";
import type { SeasonState } from "../sun";
import type { CrownForm } from "./treeStructure";
import type { BarkAttributes, FoliageAttributes, TreeJob } from "../workers/treeJobs";
import { buildTreesInWorkers } from "../workers/treeWorkerPool";
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
 * smaller fraction below. */
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
 * below) into a single mesh — the tree/bark/leaf equivalent of `instanced`
 * for geometry that can't be shared via instancing because every tree's
 * structure is genuinely unique. */
function merged(
  geometries: THREE.BufferGeometry[],
  material: THREE.Material,
  name: string
): THREE.Mesh | null {
  if (geometries.length === 0) return null;
  const geometry = mergeGeometries(geometries, false);
  if (!geometry) return null;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = name;
  return mesh;
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
    geometry.setIndex(new THREE.BufferAttribute(foliage.index, 1));
  }
  return geometry;
}

export async function buildVegetation(
  elements: DiscreteElement[],
  anchor: GeoAnchor,
  materials: MaterialLibrary,
  season: SeasonState
): Promise<THREE.Group> {
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
  // is translated to its world position, then everything is merged into
  // exactly one bark mesh, one broadleaf mesh, and one needle mesh below,
  // instead of hundreds of individual draw calls.
  const barkGeometries: THREE.BufferGeometry[] = [];
  const broadleafLeafGeometries: THREE.BufferGeometry[] = [];
  const needleGeometries: THREE.BufferGeometry[] = [];
  const treeJobs: TreeJob[] = [];

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
    const density = isEvergreen ? 1 : season.leafDensity;
    const autumnMix = isEvergreen ? 0 : season.autumnMix;

    const crownBaseFraction = isEvergreen ? CROWN_BASE_FRACTION_EVERGREEN : CROWN_BASE_FRACTION;
    const trunkTop = Math.max(height * crownBaseFraction, 0.3);
    const trunkRadius = Math.max(canopyDiameter / 20, MIN_TRUNK_RADIUS_M);

    trunks.push(
      new THREE.Matrix4()
        .makeScale(trunkRadius, trunkTop, trunkRadius)
        .setPosition(x, 0, z)
    );

    treeJobs.push({
      id: element.id,
      x,
      z,
      trunkTop,
      height,
      canopyDiameter,
      crownForm,
      isEvergreen,
      density,
      autumnMix,
    });
  }

  // Every tree's structure/bark/foliage generation is pure per-tree math
  // with no cross-tree dependency (see `workers/treeWorker.ts`), so it runs
  // across a worker pool rather than inline here — see
  // `workers/treeWorkerPool.ts` for why (measured ~1.7-1.8s of this
  // function's own wall-clock time otherwise, ~62% of it in foliage alone).
  const treeResults = await buildTreesInWorkers(treeJobs);
  for (const result of treeResults) {
    barkGeometries.push(barkGeometryFromAttributes(result.bark));
    if (result.foliage) {
      const foliageGeometry = foliageGeometryFromAttributes(result.foliage);
      if (result.foliage.kind === "needle") {
        needleGeometries.push(foliageGeometry);
      } else {
        broadleafLeafGeometries.push(foliageGeometry);
      }
    }
  }

  const trunkMesh = instanced(trunkGeometry, materials.bark(), trunks, "tree-trunks");
  if (trunkMesh) group.add(trunkMesh);

  const barkMesh = merged(barkGeometries, materials.bark(), "tree-bark");
  if (barkMesh) group.add(barkMesh);

  const broadleafMesh = merged(broadleafLeafGeometries, materials.foliage(broadleafAtlas), "tree-leaves-broadleaf");
  if (broadleafMesh) group.add(broadleafMesh);

  const needleMesh = merged(needleGeometries, materials.needles(), "tree-needles");
  if (needleMesh) group.add(needleMesh);

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

  return group;
}
