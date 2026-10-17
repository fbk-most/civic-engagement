/** People walking through the square.
 *
 * Each walker comes in at a path end on the edge of the site, walks to a
 * destination — straight across to another exit, or to a kiosk, playground
 * or fountain where they stop for a while — and leaves; then someone else
 * comes in elsewhere under the same id. Routes are shortest paths on the
 * repaired footpath network (see network.ts), as they feel: at night,
 * unlit stretches count as longer, so people prefer lit paths; and so do
 * stretches in strong heat or cold (comfort.ts), so people take the shade
 * in summer and the sun in winter. Where they stop feels the temperature
 * too: fewer go to a hot playground, more to a fountain on a hot day.
 *
 * Who walks (character, speed, whether they have a dog) is fixed per walker
 * id, like the rest of the crowd. Where along their route each one is
 * depends on how long the view has been open.
 */

import { hashString, hashUnit } from "../hash";
import { CHARACTERS, standingHeight } from "./characters";
import { stayFactor, visitFactor } from "./comfort";
import { findRoute, type NetworkComponent, type RouteConditions, type WalkNetwork } from "./network";
import { Track } from "./track";

const DOG_SHARE = 0.15;
// Destination mix: the rest walk straight through to another exit.
const TO_DESTINATION = 0.3;
// However strong the pull (fountains on a hot day), most people still just
// cross.
const TO_DESTINATION_MAX = 0.5;
const STROLL = 0.15;
const PAUSE_S: [number, number] = [5, 15];
// How quickly a walker's heading follows a bend in the path (1/s).
const TURN_RATE = 6;

// One breed for now; the pack's Shiba Inu would make a natural second.
export type DogBreed = "husky";

export interface WalkerSpec {
  id: string;
  character: number;
  height: number;
  /** Metres per second. */
  speed: number;
  /** How far right of the path's centre line they keep. */
  keepRight: number;
  dog: DogBreed | null;
}

function draw(key: string): number {
  return hashUnit(key);
}

/** `count` walkers (see `walkerCount` in plan.ts). They're numbered, so a
 * busier hour adds walkers and a quieter one removes the highest-numbered —
 * the others carry on undisturbed. */
export function planWalkers(count: number, network: WalkNetwork | null): WalkerSpec[] {
  if (!network || network.components.length === 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const id = `walker-${i}`;
    const character = hashString(`${id}:character`) % CHARACTERS.length;
    const dogDraw = draw(`${id}:dog`);
    return {
      id,
      character,
      height: standingHeight(CHARACTERS[character].build, draw(`${id}:height`)),
      speed: 1.1 + draw(`${id}:speed`) * 0.4,
      keepRight: 0.25 + draw(`${id}:right`) * 0.45,
      dog: dogDraw < DOG_SHARE ? "husky" : null,
    };
  });
}

/** Index into `weights`, with probability proportional to its weight, for a
 * 0-1 draw `u`. */
function pickWeighted(weights: number[], u: number): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let left = u * total;
  for (let i = 0; i < weights.length; i++) {
    left -= weights[i];
    if (left < 0) return i;
  }
  return weights.length - 1;
}

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

type Point = [number, number];

export type WalkerState = "walking" | "pausing";

export class WalkerMotion {
  readonly spec: WalkerSpec;
  x = 0;
  z = 0;
  /** Facing direction (radians about +Y, 0 facing +Z). */
  yaw = 0;
  state: WalkerState = "walking";

  private readonly network: WalkNetwork;
  private readonly component: NetworkComponent;
  private readonly random: () => number;
  private conditions: RouteConditions;
  private track: Track | null = null;
  private travelled = 0;
  private pauseLeft = 0;
  private pauseLookAt: Point | null = null;
  /** Where the current trip ends, and what happens there. */
  private goal: { node: number; lookAt: Point | null; leave: boolean } | null = null;
  private readonly sample = { x: 0, z: 0, heading: 0 };

  constructor(spec: WalkerSpec, network: WalkNetwork, conditions: RouteConditions) {
    this.spec = spec;
    this.network = network;
    this.conditions = conditions;
    this.random = seeded(hashString(`${spec.id}:trips`));
    // Bigger pieces of the network get proportionally more walkers.
    const total = network.components.reduce((sum, c) => sum + c.length, 0);
    let pick = this.random() * total;
    this.component = network.components.find((c) => (pick -= c.length) <= 0) ?? network.components[0];
    this.startTrip(this.pickExit());
    // Mid-trip on arrival, so the square isn't empty while everyone is
    // still walking in from the edges.
    if (this.track) this.travelled = this.random() * this.track.length;
    this.place(0, true);
  }

  /** For the next trip: the one under way keeps its route. */
  setConditions(conditions: RouteConditions): void {
    this.conditions = conditions;
  }

  update(delta: number): void {
    if (this.state === "pausing") {
      this.pauseLeft -= delta;
      if (this.pauseLookAt) this.turnTowards(Math.atan2(this.pauseLookAt[0] - this.x, this.pauseLookAt[1] - this.z), delta);
      if (this.pauseLeft <= 0) {
        this.state = "walking";
        const from = this.goal?.node;
        this.startTrip(from ?? this.pickExit(), true);
      }
      return;
    }
    if (!this.track) {
      this.startTrip(this.pickExit());
      return;
    }
    this.travelled += this.spec.speed * delta;
    if (this.travelled >= this.track.length) {
      this.arrive();
      return;
    }
    this.place(delta, false);
  }

  private place(delta: number, snap: boolean): void {
    if (!this.track) return;
    this.track.sample(this.travelled, this.sample);
    this.x = this.sample.x;
    this.z = this.sample.z;
    if (snap) this.yaw = this.sample.heading;
    else this.turnTowards(this.sample.heading, delta);
  }

  private turnTowards(target: number, delta: number): void {
    const diff = Math.atan2(Math.sin(target - this.yaw), Math.cos(target - this.yaw));
    this.yaw += diff * (1 - Math.exp(-delta * TURN_RATE));
  }

  private arrive(): void {
    const goal = this.goal;
    if (goal && !goal.leave) {
      this.state = "pausing";
      this.pauseLeft = PAUSE_S[0] + this.random() * (PAUSE_S[1] - PAUSE_S[0]);
      this.pauseLookAt = goal.lookAt;
      return;
    }
    // Left the site: someone new comes in at another exit.
    this.startTrip(this.pickExit());
    this.place(0, true);
  }

  private pickExit(): number {
    const exits = this.component.exits;
    return exits[Math.floor(this.random() * exits.length)];
  }

  /** From `from` to a new goal. `leaving` forces the goal to be an exit (a
   * walker who has had their stop heads out). */
  private startTrip(from: number, leaving = false): void {
    for (let attempt = 0; attempt < 5; attempt++) {
      const roll = this.random();
      const destinations = this.component.destinations;
      const felt = this.conditions.felt;
      // Each destination draws its share of TO_DESTINATION, times how much
      // its felt temperature puts people off (or, a fountain on a hot day,
      // draws them): a hot playground loses visitors to the way out. Read
      // where they'd stand, not at the thing itself (a fountain's basin
      // has no felt temperature).
      const pulls = destinations.map((target) =>
        felt ? visitFactor(target.kind, felt(...this.network.nodes[target.node])) : 1
      );
      const toDestination = Math.min(
        TO_DESTINATION_MAX,
        (TO_DESTINATION * pulls.reduce((sum, pull) => sum + pull, 0)) / Math.max(1, pulls.length)
      );
      let goal: { node: number; lookAt: Point | null; leave: boolean };
      if (!leaving && roll < toDestination && destinations.length > 0) {
        const target = destinations[pickWeighted(pulls, this.random())];
        goal = { node: target.node, lookAt: target.lookAt, leave: false };
      } else if (!leaving && roll < toDestination + STROLL) {
        // A stroll to somewhere in the middle, a look around, then out —
        // unless it's too hot or cold there to stand around.
        const nodes = this.component.nodes;
        const node = nodes[Math.floor(this.random() * nodes.length)];
        const stay = felt ? stayFactor(felt(...this.network.nodes[node])) : 1;
        goal =
          this.random() < stay
            ? { node, lookAt: null, leave: false }
            : { node: this.pickExit(), lookAt: null, leave: true };
      } else {
        goal = { node: this.pickExit(), lookAt: null, leave: true };
      }
      const route = findRoute(this.network, from, goal.node, this.conditions);
      if (!route || route.length < 2) continue;
      this.goal = goal;
      this.track = new Track(
        route.map((node) => this.network.nodes[node]),
        this.spec.keepRight
      );
      this.travelled = 0;
      return;
    }
    this.track = null;
  }
}
