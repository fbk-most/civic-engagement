/** A dog with its owner: walking a little ahead and to the side of a walker,
 * or standing next to someone sitting or standing still, on a leash.
 *
 * The dog isn't routed on the network itself — it chases a point just ahead
 * of its owner with a little lag, which is what a dog on a leash does.
 */

import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { DogAsset } from "./assets";
import type { DogBreed } from "./walkers";

interface BreedSpec {
  /** Standing height (top of the head), metres. */
  height: number;
  /** Ground speed the walk clip is animated for at that height (m/s) —
   * tuned by eye, since these rigs don't expose their stride. */
  walkSpeed: number;
  /** Bone the leash clips to. */
  collar: string;
  /** Clip for standing about; the husky sniffs the ground. */
  idle: string;
}

const BREEDS: Record<DogBreed, BreedSpec> = {
  husky: { height: 0.75, walkSpeed: 1.0, collar: "Neck3", idle: "Sniff" },
};

// Where the dog heads for, in the owner's frame (side, front): ahead and to
// the right while walking, beside them when they stop.
const WALK_OFFSET: [number, number] = [0.55, 1.2];
const STAND_OFFSET: [number, number] = [0.7, 0.35];
// Further than this from where it should be (the owner just came in at a
// new exit), the dog is simply placed there.
const SNAP_DISTANCE_M = 4;
const FOLLOW_RATE = 2.5;
const LEASH_POINTS = 12;
const LEASH_SAG_M = 0.25;

const leashMaterial = new THREE.LineBasicMaterial({ color: 0x2b2b2b });

export interface DogOwner {
  x: number;
  z: number;
  yaw: number;
  walking: boolean;
  /** The hand holding the leash, or null to hang it from the body. */
  hand: THREE.Object3D | null;
  /** Where the dog stays while the owner isn't walking, in the owner's
   * frame (side, front) — overrides the default beside-them spot. */
  offset?: [number, number];
}

export class Dog {
  readonly root: THREE.Object3D;
  private readonly mixer: THREE.AnimationMixer;
  private readonly walk: THREE.AnimationAction;
  private readonly idle: THREE.AnimationAction;
  private readonly spec: BreedSpec;
  private readonly scale: number;
  private readonly collar: THREE.Object3D | null;
  private readonly leash: THREE.Line;
  private x = 0;
  private z = 0;
  private yaw = 0;
  private speed = 0;
  private placed = false;
  private readonly hand = new THREE.Vector3();
  private readonly neck = new THREE.Vector3();

  constructor(breed: DogBreed, asset: DogAsset, parent: THREE.Object3D, phase: number) {
    this.spec = BREEDS[breed];
    this.root = SkeletonUtils.clone(asset.scene);
    this.scale = this.spec.height / asset.modelHeight;
    this.root.scale.setScalar(this.scale);
    parent.add(this.root);

    this.mixer = new THREE.AnimationMixer(this.root);
    const clip = (name: string) => THREE.AnimationClip.findByName(asset.clips, name) ?? asset.clips[0];
    this.walk = this.mixer.clipAction(clip("Walk"));
    this.idle = this.mixer.clipAction(clip(this.spec.idle));
    this.walk.play();
    this.idle.play();
    this.walk.setEffectiveWeight(0);
    this.mixer.setTime(phase * this.idle.getClip().duration);

    let collar: THREE.Object3D | null = null;
    this.root.traverse((object) => {
      if (object.name === THREE.PropertyBinding.sanitizeNodeName(this.spec.collar)) collar = object;
      const mesh = object as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) mesh.frustumCulled = false;
    });
    this.collar = collar;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(LEASH_POINTS * 3), 3));
    this.leash = new THREE.Line(geometry, leashMaterial);
    this.leash.frustumCulled = false;
    parent.add(this.leash);
  }

  update(delta: number, owner: DogOwner): void {
    const [side, front] = owner.walking ? WALK_OFFSET : (owner.offset ?? STAND_OFFSET);
    const cos = Math.cos(owner.yaw);
    const sin = Math.sin(owner.yaw);
    const tx = owner.x + side * cos + front * sin;
    const tz = owner.z - side * sin + front * cos;

    const dx = tx - this.x;
    const dz = tz - this.z;
    const distance = Math.hypot(dx, dz);
    if (!this.placed || distance > SNAP_DISTANCE_M) {
      this.x = tx;
      this.z = tz;
      this.yaw = owner.yaw;
      this.speed = 0;
      this.placed = true;
    } else if (delta > 0) {
      const step = Math.min(distance, distance * (1 - Math.exp(-delta * FOLLOW_RATE)));
      this.speed = step / delta;
      if (distance > 0.05) {
        this.x += (dx / distance) * step;
        this.z += (dz / distance) * step;
      }
      // Face the way it's going; once stopped, the way its owner faces.
      const targetYaw = this.speed > 0.2 ? Math.atan2(dx, dz) : owner.yaw;
      const diff = Math.atan2(Math.sin(targetYaw - this.yaw), Math.cos(targetYaw - this.yaw));
      this.yaw += diff * (1 - Math.exp(-delta * 5));
    }
    this.root.position.set(this.x, 0, this.z);
    this.root.rotation.y = this.yaw;

    const walking = this.speed > 0.15;
    this.walk.setEffectiveWeight(walking ? 1 : 0);
    this.idle.setEffectiveWeight(walking ? 0 : 1);
    this.walk.timeScale = THREE.MathUtils.clamp(this.speed / this.spec.walkSpeed, 0.5, 2);
    this.mixer.update(delta);
    this.updateLeash(owner);
  }

  private updateLeash(owner: DogOwner): void {
    this.root.updateMatrixWorld(true);
    if (owner.hand) owner.hand.getWorldPosition(this.hand);
    else this.hand.set(owner.x, 0.9, owner.z);
    if (this.collar) this.collar.getWorldPosition(this.neck);
    else this.neck.set(this.x, this.spec.height * 0.7, this.z);

    const positions = this.leash.geometry.getAttribute("position") as THREE.BufferAttribute;
    const length = this.hand.distanceTo(this.neck);
    // A slack leash sags; a taut one (dog pulling ahead) barely does.
    const sag = LEASH_SAG_M * THREE.MathUtils.clamp(1.6 - length / 1.2, 0.15, 1);
    for (let i = 0; i < LEASH_POINTS; i++) {
      const t = i / (LEASH_POINTS - 1);
      positions.setXYZ(
        i,
        this.hand.x + (this.neck.x - this.hand.x) * t,
        this.hand.y + (this.neck.y - this.hand.y) * t - sag * 4 * t * (1 - t),
        this.hand.z + (this.neck.z - this.hand.z) * t
      );
    }
    positions.needsUpdate = true;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.root.removeFromParent();
    this.root.traverse((object) => (object as THREE.SkinnedMesh).skeleton?.dispose());
    this.leash.removeFromParent();
    this.leash.geometry.dispose();
  }
}
