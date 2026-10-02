/** Loads the crowd's models (people and dogs) once per session.
 *
 * The .glb files are prepared by `scripts/prepare-crowd-assets.mjs`: one
 * skinned mesh and one palette-textured material per model, only the clips
 * the crowd uses, meshopt-compressed.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { CHARACTERS } from "./characters";
import { addLampLighting } from "../lampLighting";
import type { DogBreed } from "./walkers";

export interface CharacterAsset {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  /** Bind-pose height in the model's own units, for scaling to metres. */
  modelHeight: number;
  /** Ground speed the walk clip is animated for, in model units per second
   * at normal playback: matching playback to the actual speed is what keeps
   * the feet from sliding. */
  walkSpeed: number;
}

export interface DogAsset {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  modelHeight: number;
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

async function loadModel(url: string): Promise<{ scene: THREE.Group; clips: THREE.AnimationClip[]; modelHeight: number }> {
  const gltf = await loader.loadAsync(url);
  gltf.scene.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    addLampLighting(mesh.material as THREE.Material);
    // The palette texture is a strip of flat colour swatches: any
    // filtering blends neighbouring swatches into each other.
    const map = (mesh.material as THREE.MeshStandardMaterial).map;
    if (map) {
      map.magFilter = THREE.NearestFilter;
      map.minFilter = THREE.NearestFilter;
      map.generateMipmaps = false;
      map.needsUpdate = true;
    }
  });
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  return { scene: gltf.scene, clips: gltf.animations, modelHeight: box.max.y - box.min.y };
}

/** How fast a planted foot moves backwards in the walk clip — the speed the
 * body would travel at. The feet on these rigs are IK controls animated in
 * the root's space, so a foot's position track *is* its path relative to
 * the body: find the stretch where it's lowest (on the ground) and measure
 * how far it slides per second there. */
function measureWalkSpeed(clips: THREE.AnimationClip[]): number {
  const walk = THREE.AnimationClip.findByName(clips, "Walk");
  const track = walk?.tracks.find((t) => t.name === `${THREE.PropertyBinding.sanitizeNodeName("Foot.L")}.position`);
  if (!track) return 1.2;
  const times = track.times;
  const values = track.values;
  let minY = Infinity;
  for (let i = 0; i < times.length; i++) minY = Math.min(minY, values[i * 3 + 1]);
  let distance = 0;
  let duration = 0;
  for (let i = 1; i < times.length; i++) {
    const grounded = values[i * 3 + 1] < minY + 0.01 && values[(i - 1) * 3 + 1] < minY + 0.01;
    if (!grounded) continue;
    distance += Math.hypot(values[i * 3] - values[(i - 1) * 3], values[i * 3 + 2] - values[(i - 1) * 3 + 2]);
    duration += times[i] - times[i - 1];
  }
  return duration > 0 ? distance / duration : 1.2;
}

let characters: Promise<CharacterAsset[]> | null = null;

export function loadCharacters(): Promise<CharacterAsset[]> {
  if (!characters) {
    characters = Promise.all(
      CHARACTERS.map(async ({ file }) => {
        const model = await loadModel(`/assets/3d/people/${file}.glb`);
        return { ...model, walkSpeed: measureWalkSpeed(model.clips) };
      })
    );
    // A failed load (e.g. a missing file) shouldn't poison every later
    // attempt in the session.
    characters.catch(() => {
      characters = null;
    });
  }
  return characters;
}

let dogs: Promise<Record<DogBreed, DogAsset>> | null = null;

export function loadDogs(): Promise<Record<DogBreed, DogAsset>> {
  if (!dogs) {
    dogs = loadModel("/assets/3d/animals/husky.glb").then((husky) => ({ husky }));
    dogs.catch(() => {
      dogs = null;
    });
  }
  return dogs;
}

export interface VehicleAsset {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Model-space extent (x: width, y: height, z: length), for placing lights. */
  size: THREE.Vector3;
}

export const VEHICLE_FILES = ["car-a", "car-b", "suv", "sports"];

let vehicles: Promise<VehicleAsset[]> | null = null;

/** Each vehicle is a single rigid mesh (see prepare-crowd-assets.mjs), drawn
 * instanced — so only its geometry and material are needed, with the node's
 * transform baked into the geometry. */
export function loadVehicles(): Promise<VehicleAsset[]> {
  if (!vehicles) {
    vehicles = Promise.all(
      VEHICLE_FILES.map(async (file) => {
        const { scene } = await loadModel(`/assets/3d/vehicles/${file}.glb`);
        let found: THREE.Mesh | null = null;
        scene.traverse((object) => {
          if ((object as THREE.Mesh).isMesh && !found) found = object as THREE.Mesh;
        });
        if (!found) throw new Error(`no mesh in ${file}.glb`);
        const mesh = found as THREE.Mesh;
        // Attributes are quantized (normalized integers, with the real
        // scale carried by the node's transform); baking that transform in
        // needs full floats, or positions would be clamped back to ±1.
        const geometry = new THREE.BufferGeometry();
        for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
          const values = new Float32Array(attribute.count * attribute.itemSize);
          for (let i = 0; i < attribute.count; i++) {
            for (let k = 0; k < attribute.itemSize; k++) values[i * attribute.itemSize + k] = attribute.getComponent(i, k);
          }
          geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
        }
        geometry.setIndex(mesh.geometry.index);
        geometry.applyMatrix4(mesh.matrixWorld);
        geometry.computeBoundingBox();
        const size = geometry.boundingBox!.getSize(new THREE.Vector3());
        const material = mesh.material as THREE.MeshStandardMaterial;
        const map = material.map;
        if (map) {
          map.magFilter = THREE.NearestFilter;
          map.minFilter = THREE.NearestFilter;
          map.generateMipmaps = false;
          map.needsUpdate = true;
        }
        return { geometry, material, size };
      })
    );
    vehicles.catch(() => {
      vehicles = null;
    });
  }
  return vehicles;
}
