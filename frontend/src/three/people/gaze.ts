/** Head turns: the cheapest thing that makes a standing or seated figure
 * read as a person paying attention to something rather than a statue
 * with breathing.
 *
 * People in a group (sharing a bench, chatting on a path, at the same kiosk)
 * take turns being the one "talking": the others look at them, they look at
 * one of the others. People on their own mostly look ahead and glance around
 * now and then. Timing comes from a per-person seeded generator, so it
 * doesn't depend on frame rate or on who else is on screen.
 */

import { hashString } from "../hash";
import { BODY_UP, type PoseLayer } from "./poseLayer";

// How far a head turns before the shoulders would have to follow.
const MAX_TURN = (70 * Math.PI) / 180;
// Share of the turn taken by the neck; the head does the rest.
const NECK_SHARE = 0.35;
// How quickly the head settles on a new target (1/s).
const TURN_RATE = 3;

/** Small seeded PRNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function wrap(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export class GazeGroup {
  readonly members: Gaze[] = [];
  private readonly random: () => number;
  private speaker = 0;
  private listenedTo = 1;
  private nextSwitch = 0;

  constructor(key: string) {
    this.random = seeded(hashString(`${key}:talk`));
    this.nextSwitch = this.random() * 3;
  }

  /** Who `member` should be looking at right now. */
  focusOf(member: Gaze, time: number): Gaze {
    if (time >= this.nextSwitch) {
      this.speaker = Math.floor(this.random() * this.members.length);
      // The speaker addresses one of the others.
      this.listenedTo = (this.speaker + 1 + Math.floor(this.random() * (this.members.length - 1))) % this.members.length;
      this.nextSwitch = time + 3 + this.random() * 4;
    }
    const speaker = this.members[this.speaker];
    return member === speaker ? this.members[this.listenedTo] : speaker;
  }
}

export class Gaze {
  group: GazeGroup | null = null;
  private readonly x: number;
  private readonly z: number;
  private readonly yaw: number;
  private readonly random: () => number;
  private current = 0;
  private target = 0;
  private nextGlance: number;

  constructor(id: string, x: number, z: number, yaw: number) {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.random = seeded(hashString(`${id}:gaze`));
    this.nextGlance = this.random() * 4;
  }

  update(delta: number, time: number, layer: PoseLayer): void {
    const group = this.group && this.group.members.length > 1 ? this.group : null;
    if (group) {
      const focus = group.focusOf(this, time);
      this.target = wrap(Math.atan2(focus.x - this.x, focus.z - this.z) - this.yaw);
    } else if (time >= this.nextGlance) {
      // Mostly straight ahead, sometimes a look to one side.
      this.target =
        this.random() < 0.55
          ? (this.random() - 0.5) * 0.3
          : (this.random() < 0.5 ? -1 : 1) * (0.4 + this.random() * 0.8);
      this.nextGlance = time + 2 + this.random() * 5;
    }
    const target = Math.max(-MAX_TURN, Math.min(MAX_TURN, this.target));
    this.current += (target - this.current) * (1 - Math.exp(-delta * TURN_RATE));
    layer.rotate("Neck", BODY_UP, this.current * NECK_SHARE);
    layer.rotate("Head", BODY_UP, this.current * (1 - NECK_SHARE));
  }
}
