/** The people (and dogs) in the 3D view: keeps a set of animated figures in
 * sync with a `planCrowd` result and a set of walkers, and advances them
 * every frame.
 *
 * Updates are incremental — a person whose id survives a replan keeps its
 * object (and its place in its animation), so moving the hour slider or
 * adding a card only adds and removes the people it actually affects.
 */

import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { hashString } from "../hash";
import { loadCharacters, loadDogs, type CharacterAsset, type DogAsset } from "./assets";
import { Dog, type DogOwner } from "./dog";
import { GazeGroup, Gaze } from "./gaze";
import type { WalkNetwork } from "./network";
import type { PersonPlacement } from "./plan";
import { PoseLayer } from "./poseLayer";
import { applySeatedPose, hipCentre } from "./seatedPose";
import { WalkerMotion, type DogBreed, type WalkerSpec } from "./walkers";

// Where the hip joints sit above the ground on a bench (seat top ~0.48 m,
// see buildBenchGeometry, plus the thigh's thickness).
const SEAT_HIP_HEIGHT_M = 0.57;
// Blend time between walking and standing still.
const GAIT_BLEND_RATE = 4;

interface Actor {
  id: string;
  pose: "sitting" | "standing" | "walking";
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  layer: PoseLayer;
  gaze: Gaze;
  group: string | null;
  /** Where they are and face (for walkers, updated every frame). */
  x: number;
  z: number;
  yaw: number;
  hand: THREE.Object3D | null;
  dog: Dog | null;
  walker: {
    motion: WalkerMotion;
    walk: THREE.AnimationAction;
    idle: THREE.AnimationAction;
    /** Walk clip playback rate that matches this person's speed. */
    timeScale: number;
    blend: number;
  } | null;
}

export class Crowd {
  readonly group = new THREE.Group();
  private readonly actors = new Map<string, Actor>();
  private plan: PersonPlacement[] = [];
  private walkerSpecs: WalkerSpec[] = [];
  private network: WalkNetwork | null = null;
  private dark = false;
  private characters: CharacterAsset[] | null = null;
  private dogs: Record<DogBreed, DogAsset> | null = null;
  private disposed = false;
  private time = 0;
  /** Figures added since the last `update`/`settle`, not yet fully posed. */
  private unsettled = false;
  private readonly scratch = new THREE.Vector3();

  constructor() {
    this.group.name = "crowd";
    Promise.all([loadCharacters(), loadDogs()])
      .then(([characters, dogs]) => {
        if (this.disposed) return;
        this.characters = characters;
        this.dogs = dogs;
        this.sync();
      })
      .catch((error) => console.error("Could not load the crowd's models", error));
  }

  setPlan(plan: PersonPlacement[]): void {
    this.plan = plan;
    this.sync();
  }

  /** A new network (the paths changed) restarts every walker on it; the
   * same network only adds/removes walkers as the count changes. */
  setWalkers(specs: WalkerSpec[], network: WalkNetwork | null, dark: boolean): void {
    if (network !== this.network) {
      for (const [id, actor] of this.actors) {
        if (actor.walker) {
          this.remove(actor);
          this.actors.delete(id);
        }
      }
      this.network = network;
    }
    this.walkerSpecs = specs;
    this.dark = dark;
    for (const actor of this.actors.values()) actor.walker?.motion.setDark(dark);
    this.sync();
  }

  /** For a frozen crowd: pose (and put dogs next to their owners) anyone
   * added since last time, without advancing anything. */
  settle(): void {
    if (!this.unsettled) return;
    this.unsettled = false;
    for (const actor of this.actors.values()) {
      this.animate(actor, 0);
      actor.dog?.update(0, this.ownerOf(actor));
    }
  }

  /** Everyone is animated, however far: skipping distant figures froze
   * walkers mid-stride, sliding along the path, and that shows. */
  update(delta: number): void {
    this.unsettled = false;
    this.time += delta;
    for (const actor of this.actors.values()) {
      if (actor.walker) this.move(actor, delta);
      this.animate(actor, delta);
      actor.dog?.update(delta, this.ownerOf(actor));
    }
  }

  private ownerOf(actor: Actor): DogOwner {
    return {
      x: actor.x,
      z: actor.z,
      yaw: actor.yaw,
      walking: actor.walker?.motion.state === "walking",
      hand: actor.hand,
      offset: actor.pose === "sitting" ? SEATED_DOG_OFFSET : undefined,
    };
  }

  /** How many figures are in the scene (for the performance readout). */
  counts(): { people: number; dogs: number } {
    let dogs = 0;
    for (const actor of this.actors.values()) if (actor.dog) dogs++;
    return { people: this.actors.size, dogs };
  }

  /** Where the walkers are, for cars to give way at crossings. */
  walkerPositions(): [number, number][] {
    const positions: [number, number][] = [];
    for (const actor of this.actors.values()) if (actor.walker) positions.push([actor.x, actor.z]);
    return positions;
  }

  dispose(): void {
    this.disposed = true;
    for (const actor of this.actors.values()) this.remove(actor);
    this.actors.clear();
  }

  private move(actor: Actor, delta: number): void {
    const walker = actor.walker!;
    walker.motion.update(delta);
    actor.x = walker.motion.x;
    actor.z = walker.motion.z;
    actor.yaw = walker.motion.yaw;
    actor.root.position.set(actor.x, 0, actor.z);
    actor.root.rotation.y = actor.yaw;
  }

  private animate(actor: Actor, delta: number): void {
    const walker = actor.walker;
    if (walker) {
      const target = walker.motion.state === "walking" ? 1 : 0;
      walker.blend += (target - walker.blend) * (1 - Math.exp(-delta * GAIT_BLEND_RATE));
      walker.walk.setEffectiveWeight(walker.blend);
      walker.idle.setEffectiveWeight(1 - walker.blend);
      walker.walk.timeScale = walker.timeScale;
    }
    actor.mixer.update(delta);
    actor.layer.begin();
    if (actor.pose === "sitting") applySeatedPose(actor.layer);
    actor.gaze.update(delta, this.time, actor.layer);
  }

  private sync(): void {
    if (!this.characters || !this.dogs) return;
    const wanted = new Set<string>([...this.plan.map((p) => p.id), ...this.walkerSpecs.map((w) => w.id)]);
    for (const [id, actor] of this.actors) {
      if (!wanted.has(id)) {
        this.remove(actor);
        this.actors.delete(id);
      }
    }
    for (const placement of this.plan) {
      if (!this.actors.has(placement.id)) {
        this.actors.set(placement.id, this.createPlaced(placement));
        this.unsettled = true;
      }
    }
    if (this.network) {
      for (const spec of this.walkerSpecs) {
        if (!this.actors.has(spec.id)) {
          this.actors.set(spec.id, this.createWalker(spec, this.network));
          this.unsettled = true;
        }
      }
    }

    // Regrouped from scratch: a replan can add or remove group members.
    const groups = new Map<string, GazeGroup>();
    for (const actor of this.actors.values()) {
      let group: GazeGroup | null = null;
      if (actor.group) {
        group = groups.get(actor.group) ?? new GazeGroup(actor.group);
        groups.set(actor.group, group);
        group.members.push(actor.gaze);
      }
      actor.gaze.group = group;
    }
  }

  private createFigure(
    id: string,
    character: number,
    height: number,
    x: number,
    z: number,
    yaw: number
  ): { root: THREE.Object3D; mixer: THREE.AnimationMixer; layer: PoseLayer; asset: CharacterAsset; scale: number } {
    const asset = this.characters![character];
    const root = SkeletonUtils.clone(asset.scene);
    const scale = height / asset.modelHeight;
    root.scale.setScalar(scale);
    root.rotation.y = yaw;
    root.position.set(x, 0, z);
    root.name = id;
    this.group.add(root);
    return { root, mixer: new THREE.AnimationMixer(root), layer: new PoseLayer(root), asset, scale };
  }

  private createPlaced(placement: PersonPlacement): Actor {
    const { root, mixer, layer, asset } = this.createFigure(
      placement.id,
      placement.character,
      placement.height,
      placement.x,
      placement.z,
      placement.yaw
    );
    const clip = THREE.AnimationClip.findByName(asset.clips, placement.clip) ?? asset.clips[0];
    mixer.clipAction(clip).play();
    mixer.setTime(placement.phase * clip.duration);

    const actor: Actor = {
      id: placement.id,
      pose: placement.pose,
      root,
      mixer,
      layer,
      gaze: new Gaze(placement.id, placement.x, placement.z, placement.yaw),
      group: placement.group,
      x: placement.x,
      z: placement.z,
      yaw: placement.yaw,
      hand: layer.bone("Wrist.R") ?? null,
      dog: null,
      walker: null,
    };
    this.animate(actor, 0);
    if (placement.pose === "sitting") {
      // Move the whole figure so its hips land on the seat.
      const hips = hipCentre(layer, this.scratch);
      root.position.x += placement.x - hips.x;
      root.position.y += SEAT_HIP_HEIGHT_M - hips.y;
      root.position.z += placement.z - hips.z;
    }
    fitBounds(root);
    if (placement.dog) actor.dog = new Dog(placement.dog, this.dogs![placement.dog], this.group, placement.phase);
    return actor;
  }

  private createWalker(spec: WalkerSpec, network: WalkNetwork): Actor {
    const motion = new WalkerMotion(spec, network, this.dark);
    const { root, mixer, layer, asset, scale } = this.createFigure(
      spec.id,
      spec.character,
      spec.height,
      motion.x,
      motion.z,
      motion.yaw
    );
    const walk = mixer.clipAction(THREE.AnimationClip.findByName(asset.clips, "Walk") ?? asset.clips[0]);
    const idle = mixer.clipAction(THREE.AnimationClip.findByName(asset.clips, "Idle") ?? asset.clips[0]);
    walk.play();
    idle.play();
    mixer.setTime(seededPhase(spec.id) * walk.getClip().duration);

    const actor: Actor = {
      id: spec.id,
      pose: "walking",
      root,
      mixer,
      layer,
      gaze: new Gaze(spec.id, motion.x, motion.z, motion.yaw),
      group: null,
      x: motion.x,
      z: motion.z,
      yaw: motion.yaw,
      hand: layer.bone("Wrist.R") ?? null,
      dog: null,
      walker: { motion, walk, idle, timeScale: spec.speed / (asset.walkSpeed * scale), blend: 1 },
    };
    this.animate(actor, 0);
    fitBounds(root);
    if (spec.dog) actor.dog = new Dog(spec.dog, this.dogs![spec.dog], this.group, seededPhase(`${spec.id}:dog`));
    return actor;
  }

  private remove(actor: Actor): void {
    actor.mixer.stopAllAction();
    actor.mixer.uncacheRoot(actor.root);
    this.group.remove(actor.root);
    // Geometry and material are shared with the loaded asset and live for
    // the session; only the per-clone skeleton owns GPU state.
    actor.root.traverse((object) => (object as THREE.SkinnedMesh).skeleton?.dispose());
    actor.dog?.dispose();
  }
}

// A dog next to someone on a bench lies in front of it, not on the seat
// beside them (see Dog's offsets for the standing/walking ones).
const SEATED_DOG_OFFSET: [number, number] = [0.25, 0.95];

/** 0-1 animation phase fixed per id, so a frozen scene (see Viewer's
 * "still" mode) is the same picture every time it's loaded. */
function seededPhase(id: string): number {
  return hashString(`${id}:phase`) / 2 ** 32;
}

/** A skinned mesh's bounds come from its bind pose (arms out, standing),
 * which a seated, walking or moved figure no longer matches; recompute
 * them from the posed skeleton so frustum culling doesn't clip people at
 * the edge of the view. */
function fitBounds(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    mesh.computeBoundingSphere();
    mesh.boundingSphere!.radius *= 1.3;
  });
}
