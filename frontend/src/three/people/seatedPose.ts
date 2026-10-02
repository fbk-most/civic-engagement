/** A sitting pose built on top of a standing idle clip — the character pack
 * has no sitting animation, but its idle keeps the breathing and small
 * movements that make a seated figure look alive.
 *
 * The feet on these rigs are IK controls parented to the skeleton's root,
 * not children of the shins. Bending the knees therefore does nothing to
 * them: they'd stay on the ground under the lifted body and drag the shins
 * down to meet them. They're moved to the end of each shin explicitly.
 */

import * as THREE from "three";
import { BODY_RIGHT, type PoseLayer } from "./poseLayer";

// Angles in radians about the body's left-right axis; negative tips a
// hanging limb forward.
const BENDS: [string, number][] = [
  ["Abdomen", -0.12], // a slight lean back, against the backrest
  ["UpperLeg.L", -Math.PI / 2 + 0.08],
  ["UpperLeg.R", -Math.PI / 2 + 0.08],
  ["LowerLeg.L", Math.PI / 2 - 0.25],
  ["LowerLeg.R", Math.PI / 2 - 0.25],
  ["UpperArm.L", -0.25], // hands resting on the lap
  ["UpperArm.R", -0.25],
  ["LowerArm.L", -0.8],
  ["LowerArm.R", -0.8],
];

const quat = new THREE.Quaternion();
const pos = new THREE.Vector3();
const shinOffset = new THREE.Vector3();

/** Call after `layer.begin()`, every frame the figure is animated. */
export function applySeatedPose(layer: PoseLayer): void {
  for (const [name, angle] of BENDS) layer.rotate(name, BODY_RIGHT, angle);

  // (getWorld* below bring each bone's ancestor chain up to date.)
  for (const side of ["L", "R"]) {
    const shin = layer.bone(`LowerLeg.${side}`);
    const foot = layer.bone(`Foot.${side}`);
    if (!shin || !foot?.parent) continue;
    // Shin and thigh are close enough in length on these rigs that the
    // thigh's (the shin's offset from its parent) stands in for it.
    const shinLength = shin.position.length() * shin.getWorldScale(pos).y;
    shin.getWorldQuaternion(quat);
    shin.getWorldPosition(pos);
    pos.add(shinOffset.set(0, shinLength, 0).applyQuaternion(quat));
    foot.position.copy(foot.parent.worldToLocal(pos));
  }
}

/** World position of the midpoint between the hip joints, for seating. */
export function hipCentre(layer: PoseLayer, target: THREE.Vector3): THREE.Vector3 {
  const left = layer.bone("UpperLeg.L");
  const right = layer.bone("UpperLeg.R");
  if (!left || !right) return target.set(0, 0, 0);
  left.getWorldPosition(target);
  return target.add(right.getWorldPosition(pos)).multiplyScalar(0.5);
}
