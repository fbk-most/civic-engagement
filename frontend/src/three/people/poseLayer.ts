/** Small bone rotations layered on top of a character's animation clip — the
 * sitting pose and head turns both use it.
 *
 * Needed because three's `AnimationMixer` only writes a bone when its
 * animated value changed since the previous frame: on bones the clip holds
 * still, a rotation applied on top would pile up frame after frame. The
 * layer remembers each bone's animated value and rotates from that instead.
 *
 * Call `begin()` once per frame right after `mixer.update`, then `rotate`
 * as many bones as needed.
 */

import * as THREE from "three";

export class PoseLayer {
  private readonly root: THREE.Object3D;
  private readonly bones = new Map<string, THREE.Object3D>();
  private readonly animated = new Map<THREE.Object3D, { base: THREE.Quaternion; rotated: THREE.Quaternion }>();
  private readonly rootQuat = new THREE.Quaternion();
  private readonly quat = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();

  constructor(root: THREE.Object3D) {
    this.root = root;
    root.traverse((object) => this.bones.set(object.name, object));
  }

  /** A bone by its name in the source model (e.g. "UpperLeg.L"). */
  bone(name: string): THREE.Object3D | undefined {
    return this.bones.get(THREE.PropertyBinding.sanitizeNodeName(name));
  }

  begin(): void {
    for (const [bone, state] of this.animated) {
      if (bone.quaternion.equals(state.rotated)) bone.quaternion.copy(state.base);
    }
    this.root.getWorldQuaternion(this.rootQuat);
  }

  /** Rotates a bone about an axis given in the *body's* frame (+X its left
   * to right, +Y up, +Z forward), through the bone's own joint. Each bone's
   * local axes are tilted differently per rig, so rotating about those
   * instead gives splayed knees and tilted heads. */
  rotate(name: string, bodyAxis: THREE.Vector3, angle: number): void {
    const bone = this.bone(name);
    if (!bone?.parent || angle === 0) return;
    let state = this.animated.get(bone);
    if (!state) {
      state = { base: new THREE.Quaternion(), rotated: new THREE.Quaternion() };
      this.animated.set(bone, state);
    }
    // Only record the base the first time a bone is touched this frame, so
    // two rotations on one bone compose instead of the second one's "base"
    // being the first one's result.
    if (!state.rotated.equals(bone.quaternion)) state.base.copy(bone.quaternion);
    this.axis
      .copy(bodyAxis)
      .applyQuaternion(this.rootQuat)
      .applyQuaternion(bone.parent.getWorldQuaternion(this.quat).invert())
      .normalize();
    bone.quaternion.premultiply(this.quat.setFromAxisAngle(this.axis, angle));
    state.rotated.copy(bone.quaternion);
  }
}

export const BODY_RIGHT = new THREE.Vector3(1, 0, 0);
export const BODY_UP = new THREE.Vector3(0, 1, 0);
