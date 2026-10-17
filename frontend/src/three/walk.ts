/** First-person walking around the square.
 *
 * The placed camera answers "what does it look like from here"; walking
 * answers "what is it like to be here", which is the question a co-design
 * workshop is actually about. Kept deliberately plain — eye height, walking
 * speed, and walls you can't pass through — because anything more elaborate
 * (jumping, flying, collision volumes for benches) would turn a discussion
 * instrument into a video game.
 */

import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { EYE_HEIGHT_M } from "./camera";

const WALK_SPEED_MS = 1.4;
const RUN_SPEED_MS = 3.6;

/** Movement is smoothed towards the target velocity rather than applied raw,
 * so starting and stopping don't snap. */
const ACCELERATION = 12;

/** Kept a little outside the footprint so the camera's near plane doesn't
 * clip through a facade when you walk up to a wall. */
const WALL_MARGIN_M = 0.35;

/** How far outside the site boundary you may wander before being stopped. */
const BOUNDS_MARGIN_M = 40;

/** How far from the fallback start to look for a spot outside any building. */
const FREE_SPOT_SEARCH_M = 60;

/** A building footprint as a flat [x, z, x, z, ...] outer ring in the local
 * metric frame. */
export type Footprint = number[];

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function insideRing(ring: Footprint, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i];
    const zi = ring[i + 1];
    const xj = ring[j];
    const zj = ring[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export class WalkController {
  readonly controls: PointerLockControls;

  private velocity = new THREE.Vector3();
  private pressed = new Set<string>();
  private footprints: Footprint[] = [];
  private bounds: Bounds | null = null;

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.controls = new PointerLockControls(camera, domElement);
  }

  setCollision(footprints: Footprint[], bounds: Bounds): void {
    this.footprints = footprints;
    this.bounds = bounds;
  }

  get isLocked(): boolean {
    return this.controls.isLocked;
  }

  /** Starts walking from where the camera stands. If that spot can't be
   * walked from — the overview camera hovers well outside the site, and
   * dropping it to eye height there would leave every step blocked — the
   * walk starts at `fallback` instead (the orbit target, i.e. what the view
   * was centred on), or the nearest free spot around it. Either way it
   * starts looking level along the same heading: a camera looking down on
   * the square would otherwise put the walker face to the pavement. */
  lock(fallback: THREE.Vector3): void {
    const object = this.controls.object;
    const heading = new THREE.Vector3();
    object.getWorldDirection(heading);
    heading.y = 0;
    if (heading.lengthSq() < 1e-6) heading.set(0, 0, -1);
    heading.normalize();

    const start = this.blocked(object.position.x, object.position.z)
      ? this.freeSpotNear(fallback.x, fallback.z)
      : object.position;
    object.position.set(start.x, EYE_HEIGHT_M, start.z);
    object.lookAt(start.x + heading.x, EYE_HEIGHT_M, start.z + heading.z);
    this.controls.lock();
  }

  /** The closest unblocked point to (x, z), searched in widening rings. */
  private freeSpotNear(x: number, z: number): { x: number; z: number } {
    if (!this.blocked(x, z)) return { x, z };
    for (let radius = 2; radius <= FREE_SPOT_SEARCH_M; radius += 2) {
      const steps = Math.ceil((2 * Math.PI * radius) / 2);
      for (let i = 0; i < steps; i++) {
        const angle = (2 * Math.PI * i) / steps;
        const cx = x + radius * Math.cos(angle);
        const cz = z + radius * Math.sin(angle);
        if (!this.blocked(cx, cz)) return { x: cx, z: cz };
      }
    }
    return { x, z };
  }

  unlock(): void {
    this.controls.unlock();
  }

  private handleKey = (event: KeyboardEvent) => {
    if (event.type === "keydown") this.pressed.add(event.code);
    else this.pressed.delete(event.code);
  };

  attach(): void {
    window.addEventListener("keydown", this.handleKey);
    window.addEventListener("keyup", this.handleKey);
  }

  detach(): void {
    window.removeEventListener("keydown", this.handleKey);
    window.removeEventListener("keyup", this.handleKey);
    this.pressed.clear();
    this.velocity.set(0, 0, 0);
  }

  /** True while the position would be inside a building or off-site. */
  private blocked(x: number, z: number): boolean {
    if (this.bounds) {
      if (
        x < this.bounds.minX - BOUNDS_MARGIN_M ||
        x > this.bounds.maxX + BOUNDS_MARGIN_M ||
        z < this.bounds.minZ - BOUNDS_MARGIN_M ||
        z > this.bounds.maxZ + BOUNDS_MARGIN_M
      ) {
        return true;
      }
    }
    // Testing the four corners of a small square around the walker, rather
    // than a single point, is what stops you slipping through a facade
    // diagonally at a corner.
    for (const ring of this.footprints) {
      for (const [ox, oz] of [
        [WALL_MARGIN_M, 0],
        [-WALL_MARGIN_M, 0],
        [0, WALL_MARGIN_M],
        [0, -WALL_MARGIN_M],
      ]) {
        if (insideRing(ring, x + ox, z + oz)) return true;
      }
    }
    return false;
  }

  update(delta: number): void {
    if (!this.controls.isLocked) return;

    const forward =
      (this.pressed.has("KeyW") || this.pressed.has("ArrowUp") ? 1 : 0) -
      (this.pressed.has("KeyS") || this.pressed.has("ArrowDown") ? 1 : 0);
    const right =
      (this.pressed.has("KeyD") || this.pressed.has("ArrowRight") ? 1 : 0) -
      (this.pressed.has("KeyA") || this.pressed.has("ArrowLeft") ? 1 : 0);

    const speed =
      this.pressed.has("ShiftLeft") || this.pressed.has("ShiftRight")
        ? RUN_SPEED_MS
        : WALK_SPEED_MS;

    // Normalised so moving diagonally isn't faster than moving straight.
    const length = Math.hypot(forward, right) || 1;
    const targetForward = (forward / length) * speed;
    const targetRight = (right / length) * speed;

    const blend = Math.min(1, ACCELERATION * delta);
    this.velocity.z += (targetForward - this.velocity.z) * blend;
    this.velocity.x += (targetRight - this.velocity.x) * blend;

    const object = this.controls.object;
    const before = object.position.clone();

    this.controls.moveRight(this.velocity.x * delta);
    this.controls.moveForward(this.velocity.z * delta);

    // Resolved one axis at a time so walking into a wall at an angle slides
    // along it instead of stopping dead.
    const after = object.position;
    if (this.blocked(after.x, before.z)) {
      after.x = before.x;
      this.velocity.x *= 0.5;
    }
    if (this.blocked(after.x, after.z)) {
      after.z = before.z;
      this.velocity.z *= 0.5;
    }
    if (this.blocked(after.x, after.z)) {
      after.copy(before);
    }

    after.y = EYE_HEIGHT_M;
  }

  dispose(): void {
    this.detach();
    this.controls.disconnect();
  }
}
