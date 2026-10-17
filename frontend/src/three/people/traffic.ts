/** Cars driving through the site.
 *
 * Cars come in near the edge of the site and wander the street network —
 * preferring to go straight on, and rarely turning into service roads —
 * until they leave it; then another comes in elsewhere. One-way streets are
 * driven in their OSM direction; two-way streets get a lane each way,
 * keeping right. Cars slow down for bends, stop at red lights (each signal
 * runs its own fixed cycle, alternating between crossing directions) and
 * before a zebra crossing while someone is on it, and keep their distance
 * from the car in front. They don't negotiate junctions with each other.
 *
 * The signals' own lenses show the same cycle the cars obey.
 *
 * Rigid models, drawn instanced — one batch per car model, so traffic costs
 * a handful of draw calls however many cars there are.
 */

import * as THREE from "three";
import type { DiscreteElement } from "../../api/types";
import { toLocal, type GeoAnchor } from "../geo";
import { hashString } from "../hash";
import { loadVehicles, VEHICLE_FILES, type VehicleAsset } from "./assets";
import { crossingAxis } from "./network";
import { Track } from "./track";
import { addLampLighting } from "../lampLighting";
import { FLAT_TERRAIN, type Terrain } from "../terrain";

type Point = [number, number];

const MAX_CARS = 90;
// One car per this much street (centre-line length) at rush hour.
const STREET_M_PER_CAR = 23;
const SPEED_STREET = 30 / 3.6;
const SPEED_SERVICE = 15 / 3.6;
const ACCELERATION = 2;
const DECELERATION = 4;
// Distance kept to the car in front, bumper to bumper plus a car length.
const FOLLOW_GAP_M = 7;
const CAR_LENGTH_M = 5;
const LOOK_AHEAD_M = 40;
// Signal cycle: green, then amber, then red; crossing directions are offset
// by half a cycle.
const SIGNAL_CYCLE_S = 50;
const SIGNAL_GREEN_S = 22;
const SIGNAL_AMBER_S = 3;
// A signal this close to a car's route controls it; the car stops this far
// before it.
const SIGNAL_REACH_M = 9;
const SIGNAL_STOP_BEFORE_M = 4;
// Signals this close together belong to the same junction.
const JUNCTION_RADIUS_M = 35;
const CROSSING_STOP_BEFORE_M = 4.5;
// Someone this close to a crossing's axis is "on" it.
const CROSSING_CLEARANCE_M = 3;
const SPAWN_CLEARANCE_M = 10;
const SPAWN_INTERVAL_S = 0.7;
// Longest step simulated at once: a slow or stalled frame (a background tab,
// a weak GPU) would otherwise move cars tens of metres in one go — straight
// through stop lines and each other.
const MAX_STEP_S = 0.1;
// A drive ends on reaching the rim after at least this far, or at a dead
// end; the upper bound only guards against endless loops.
const MIN_ROUTE_M = 150;
const MAX_ROUTE_M = 3000;
// Nodes this far out (as a share of the furthest) are the network's rim.
const RIM_SHARE = 0.85;
// Service roads (car parks, driveways) get a small share of the turns.
const SERVICE_WEIGHT = 0.15;
// Where a two-way street's lanes run, as a share of its width from the
// centre line (a quarter: the middle of each half).
const TWO_WAY_LANE_SHARE = 0.25;
// Which way the models face along their own Z axis.
const MODEL_FORWARD = 1;
// Signal lenses on the housing drawn by buildTrafficSignalGeometry
// (furniture.ts): a 0.22 (x) by 0.18 (z) box centred 2.85 m up.
const SIGNAL_HOUSING_Y = 2.85;
const SIGNAL_HOUSING_HALF: [number, number] = [0.11, 0.09];
const SIGNAL_LENS_SPACING = 0.16;
const LENS_COLOURS: Record<SignalState, THREE.Color> = {
  red: new THREE.Color(0xff2a1a),
  amber: new THREE.Color(0xffb020),
  green: new THREE.Color(0x3dff6a),
};
const LENS_ORDER: SignalState[] = ["red", "amber", "green"];
// An unlit lens: the same colour, much darker.
const LENS_OFF = 0.12;

// Body paints, roughly as common as on real streets: lots of white, grey,
// silver and black, some blue and red.
const BODY_COLOURS = [
  0xf2f2f0, 0xf2f2f0, 0xe8e8e6, 0x9fa3a6, 0xb9bcbe, 0x5b5f63, 0x2a2c2e, 0x1b1c1e, 0x23395d, 0x3b5f8a, 0x8e1b1b,
  0x6d6552, 0x2f4a3a,
];

interface RoadEdge {
  from: number;
  to: number;
  /** Lane centre, right of the centre line in the direction of travel. */
  offset: number;
  limit: number;
  service: boolean;
}

export interface RoadNetwork {
  nodes: Point[];
  edges: RoadEdge[];
  /** Edge indices leaving each node. */
  out: number[][];
  /** Edges where cars come in. */
  entries: number[];
  /** Nodes on the outer rim of the street network, where cars leave. */
  rim: Set<number>;
  /** Total street centre-line length. */
  length: number;
  /** `clock`: signals at the same junction share one cycle (see below). */
  signals: { id: string; point: Point; clock: string }[];
  crossings: { a: Point; b: Point }[];
}

function lineStrings(geometry: GeoJSON.Geometry): GeoJSON.Position[][] {
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

export function buildRoadNetwork(elements: DiscreteElement[], anchor: GeoAnchor, siteBoundary: GeoJSON.Polygon): RoadNetwork {
  const nodes: Point[] = [];
  const nodeIndex = new Map<string, number>();
  const nodeAt = (p: Point) => {
    const key = `${Math.round(p[0] * 20)},${Math.round(p[1] * 20)}`;
    let index = nodeIndex.get(key);
    if (index === undefined) {
      index = nodes.length;
      nodes.push(p);
      nodeIndex.set(key, index);
    }
    return index;
  };
  const edges: RoadEdge[] = [];
  let length = 0;

  for (const element of elements) {
    if (element.type !== "street") continue;
    const props = element.properties;
    const oneway = String(props.oneway ?? "").toLowerCase();
    const forward = oneway !== "-1";
    const backward = !["yes", "true", "1"].includes(oneway);
    const width = Number(props.width ?? 6);
    const offset = forward && backward ? width * TWO_WAY_LANE_SHARE : 0;
    const service = props.highway === "service";
    const limit = service ? SPEED_SERVICE : SPEED_STREET;
    for (const line of lineStrings(element.geometry)) {
      const points = line.map(([lng, lat]) => toLocal(anchor, lng, lat));
      for (let i = 1; i < points.length; i++) {
        const a = nodeAt(points[i - 1]);
        const b = nodeAt(points[i]);
        if (a === b) continue;
        length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
        if (forward) edges.push({ from: a, to: b, offset, limit, service });
        if (backward) edges.push({ from: b, to: a, offset, limit, service });
      }
    }
  }

  const out: number[][] = nodes.map(() => []);
  const incoming: number[][] = nodes.map(() => []);
  edges.forEach((edge, i) => {
    out[edge.from].push(i);
    incoming[edge.to].push(i);
  });

  // The street data reaches well past the site (it's fetched with a
  // margin), so cars come in and leave on the outer rim of the network —
  // the nodes furthest from the site's centre — or where a street simply
  // starts (the beginning of a one-way street, a dead end). Out of sight,
  // mostly, rather than popping up in the middle of the square.
  const boundary = (siteBoundary.coordinates[0] ?? []).map(([lng, lat]) => toLocal(anchor, lng, lat));
  const [cx, cz] = boundary.length > 0
    ? boundary.reduce(([x, z], p) => [x + p[0] / boundary.length, z + p[1] / boundary.length], [0, 0])
    : [0, 0];
  const radius = (p: Point) => Math.hypot(p[0] - cx, p[1] - cz);
  const maxRadius = nodes.reduce((max, p) => Math.max(max, radius(p)), 0);
  const rim = new Set<number>();
  nodes.forEach((p, i) => {
    if (radius(p) >= maxRadius * RIM_SHARE) rim.add(i);
  });
  const entries = edges
    .map((edge, i) => ({ edge, i }))
    .filter(({ edge }) => {
      const feeders = incoming[edge.from].filter((j) => edges[j].from !== edge.to);
      return feeders.length === 0 || rim.has(edge.from);
    })
    .map(({ i }) => i);

  const signals = elements
    .filter((e) => e.type === "traffic_signal" && e.geometry.type === "Point")
    .map((e) => ({
      id: e.id,
      point: toLocal(anchor, ...((e.geometry as GeoJSON.Point).coordinates as [number, number])),
      clock: e.id,
    }));
  // OSM often maps one junction as several signal nodes (one per approach);
  // each running its own cycle, they'd disagree about who has green. Signals
  // chained within JUNCTION_RADIUS_M of each other share one clock.
  const parent = signals.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  signals.forEach((a, i) =>
    signals.forEach((b, j) => {
      if (j > i && Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1]) <= JUNCTION_RADIUS_M) parent[find(j)] = find(i);
    })
  );
  signals.forEach((signal, i) => (signal.clock = signals[find(i)].id));
  const crossings = elements
    .filter((e) => e.type === "crossing")
    .map((e) => crossingAxis(e, anchor))
    .filter((axis) => axis !== null)
    .map((axis) => ({ a: axis.points[0], b: axis.points[1] }));

  return { nodes, edges, out, entries: entries.length > 0 ? entries : edges.map((_, i) => i), rim, length, signals, crossings };
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2));
  return Math.hypot(a[0] + dx * t - p[0], a[1] + dz * t - p[1]);
}

/** Parameter along ab where it crosses cd, if it does. */
function crossAt(a: Point, b: Point, c: Point, d: Point): number | null {
  const rx = b[0] - a[0];
  const rz = b[1] - a[1];
  const sx = d[0] - c[0];
  const sz = d[1] - c[1];
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const qx = c[0] - a[0];
  const qz = c[1] - a[1];
  const t = (qx * sz - qz * sx) / denom;
  const u = (qx * rz - qz * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

type SignalState = "green" | "amber" | "red";

/** What a signal shows to traffic approaching along one of its two axes
 * (`phase` 0 or 1): the two axes are half a cycle apart, so while one has
 * green the other has red. Shared by the cars and the lenses drawn on the
 * signal's housing, so what drivers obey is what's shown. */
function signalState(clock: string, phase: number, time: number): SignalState {
  const offset = (hashString(clock) % SIGNAL_CYCLE_S) + phase * (SIGNAL_CYCLE_S / 2);
  const t = (time + offset) % SIGNAL_CYCLE_S;
  if (t < SIGNAL_GREEN_S) return "green";
  return t < SIGNAL_GREEN_S + SIGNAL_AMBER_S ? "amber" : "red";
}

/** Which of a signal's two phases applies to a direction of travel: along
 * the local Z axis (either way) or along X. */
function phaseFor(heading: number): number {
  return Math.round(heading / (Math.PI / 2)) & 1;
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

interface Stop {
  s: number;
  signal: number | null;
  crossing: number | null;
  /** Which of a signal's two phases applies (the approach direction). */
  phase: number;
}

class Car {
  readonly model: number;
  readonly colour: THREE.Color;
  readonly track: Track;
  s = 0;
  v: number;
  x = 0;
  z = 0;
  yaw = 0;
  /** Per track segment: speed limit. Per vertex: speed cap for the bend. */
  private readonly limits: number[];
  private readonly bendCaps: number[];
  private readonly stops: Stop[];
  private readonly sample = { x: 0, z: 0, heading: 0 };

  constructor(model: number, colour: THREE.Color, network: RoadNetwork, route: number[]) {
    this.model = model;
    this.colour = colour;
    const points: Point[] = [network.nodes[network.edges[route[0]].from], ...route.map((e) => network.nodes[network.edges[e].to])];
    const offsets = points.map((_, i) => network.edges[route[Math.min(i, route.length - 1)]].offset);
    this.track = new Track(points, offsets);
    this.limits = route.map((e) => network.edges[e].limit);
    this.v = this.limits[0];

    const tp = this.track.points;
    this.bendCaps = tp.map((_, i) => {
      if (i === 0 || i === tp.length - 1) return Infinity;
      const a = Math.atan2(tp[i][0] - tp[i - 1][0], tp[i][1] - tp[i - 1][1]);
      const b = Math.atan2(tp[i + 1][0] - tp[i][0], tp[i + 1][1] - tp[i][1]);
      const turn = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
      return turn > 0.9 ? 3 : turn > 0.5 ? 4.5 : turn > 0.25 ? 6.5 : Infinity;
    });

    this.stops = [];
    network.signals.forEach((signal, index) => {
      const { s, distance } = this.track.project(signal.point);
      if (distance > SIGNAL_REACH_M || s < SIGNAL_STOP_BEFORE_M) return;
      this.track.sample(s, this.sample);
      // Approaches roughly at right angles get opposite phases.
      const phase = phaseFor(this.sample.heading);
      this.stops.push({ s: s - SIGNAL_STOP_BEFORE_M, signal: index, crossing: null, phase });
    });
    network.crossings.forEach((crossing, index) => {
      for (let i = 1; i < tp.length; i++) {
        const t = crossAt(tp[i - 1], tp[i], crossing.a, crossing.b);
        if (t === null) continue;
        const s = this.track.distances[i - 1] + (this.track.distances[i] - this.track.distances[i - 1]) * t;
        if (s > CROSSING_STOP_BEFORE_M) this.stops.push({ s: s - CROSSING_STOP_BEFORE_M, signal: null, crossing: index, phase: 0 });
      }
    });
    this.stops.sort((a, b) => a.s - b.s);
    this.place();
  }

  get finished(): boolean {
    return this.s >= this.track.length;
  }

  update(delta: number, time: number, network: RoadNetwork, blocked: (crossing: number) => boolean, gapAhead: number): void {
    const brake = (distance: number, speed = 0) => Math.sqrt(speed * speed + 2 * DECELERATION * Math.max(0, distance));
    let segment = 1;
    while (segment < this.track.distances.length - 1 && this.track.distances[segment] < this.s) segment++;
    let target = this.limits[Math.min(segment - 1, this.limits.length - 1)];

    for (let i = segment; i < this.bendCaps.length; i++) {
      const distance = this.track.distances[i] - this.s;
      if (distance > LOOK_AHEAD_M) break;
      target = Math.min(target, brake(distance, this.bendCaps[i]));
    }
    for (const stop of this.stops) {
      const distance = stop.s - this.s;
      if (distance < -0.5) continue;
      if (distance > LOOK_AHEAD_M) break;
      let halt = false;
      if (stop.crossing !== null) halt = blocked(stop.crossing);
      if (stop.signal !== null) {
        const state = signalState(network.signals[stop.signal].clock, stop.phase, time);
        // On amber, stop only if there's room to.
        halt = state === "red" || (state === "amber" && distance > (this.v * this.v) / (2 * DECELERATION));
      }
      if (halt) target = Math.min(target, brake(distance));
    }
    target = Math.min(target, brake(gapAhead - FOLLOW_GAP_M));

    const change = target - this.v;
    this.v = Math.max(0, this.v + Math.max(-DECELERATION * 1.5 * delta, Math.min(ACCELERATION * delta, change)));
    this.s += this.v * delta;
    this.place();
  }

  private place(): void {
    this.track.sample(Math.min(this.s, this.track.length), this.sample);
    this.x = this.sample.x;
    this.z = this.sample.z;
    this.yaw = this.sample.heading;
  }
}

/** The models' palette paints every body white or silver; this tints only
 * those pale body texels with each car's instance colour, leaving glass,
 * tyres, trim and lights as they are. (Plain instance colours would tint
 * the whole car, windows included.) */
function bodyTintMaterial(source: THREE.Material): THREE.Material {
  const material = source.clone();
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `#if defined( USE_INSTANCING_COLOR ) || defined( USE_COLOR )
        float carBody = smoothstep(0.55, 0.7, min(min(diffuseColor.r, diffuseColor.g), diffuseColor.b));
        diffuseColor.rgb = mix(diffuseColor.rgb, vColor.rgb * 0.9, carBody);
      #endif`
    );
  };
  material.customProgramCacheKey = () => "car-body-tint";
  return addLampLighting(material);
}

/** A drive from an entry until the car leaves the network (or has driven
 * long enough), preferring to carry on straight. */
function makeRoute(network: RoadNetwork, random: () => number): number[] | null {
  const pickWeighted = <T,>(items: T[], weight: (item: T) => number): T | null => {
    const total = items.reduce((sum, item) => sum + weight(item), 0);
    if (total <= 0) return null;
    let pick = random() * total;
    for (const item of items) if ((pick -= weight(item)) <= 0) return item;
    return items[items.length - 1];
  };
  const start = pickWeighted(network.entries, (e) => (network.edges[e].service ? SERVICE_WEIGHT : 1));
  if (start === null) return null;
  const route = [start];
  const used = new Set<number>([start]);
  let travelled = 0;
  for (;;) {
    const current = network.edges[route[route.length - 1]];
    const [ax, az] = network.nodes[current.from];
    const [bx, bz] = network.nodes[current.to];
    travelled += Math.hypot(bx - ax, bz - az);
    if (travelled > MAX_ROUTE_M || (travelled > MIN_ROUTE_M && network.rim.has(current.to))) break;
    const heading = Math.atan2(bx - ax, bz - az);
    const options = network.out[current.to].filter((e) => network.edges[e].to !== current.from && !used.has(e));
    const next = pickWeighted(options, (e) => {
      const edge = network.edges[e];
      const [cx, cz] = network.nodes[edge.to];
      const turn = Math.atan2(cx - bx, cz - bz) - heading;
      const straightness = (1 + Math.cos(turn)) / 2;
      return (edge.service ? SERVICE_WEIGHT : 1) * (0.1 + straightness * straightness);
    });
    if (next === null) break;
    route.push(next);
    used.add(next);
  }
  return route;
}

export class Traffic {
  readonly group = new THREE.Group();
  /** The ground the cars drive on (see three/terrain.ts). Set before the
   * road network: the traffic lights' lenses are placed with it. */
  terrain: Terrain = FLAT_TERRAIN;
  private network: RoadNetwork | null = null;
  private assets: VehicleAsset[] | null = null;
  private meshes: THREE.InstancedMesh[] = [];
  private headlights: THREE.InstancedMesh | null = null;
  private taillights: THREE.InstancedMesh | null = null;
  /** Three lenses on each of the four faces of every signal. */
  private lenses: THREE.InstancedMesh | null = null;
  private cars: Car[] = [];
  private target = 0;
  private dark = false;
  private time = 0;
  private spawnCooldown = 0;
  private random = seeded(hashString("traffic"));
  /** Not advancing (the view's "still" mode): see `setActivity`. */
  private frozen = false;
  /** Cars placed or lights changed since the last draw. */
  private unsettled = false;
  private disposed = false;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.group.name = "traffic";
    loadVehicles()
      .then((assets) => {
        if (this.disposed) return;
        this.assets = assets;
        this.meshes = assets.map((asset, i) => {
          const mesh = new THREE.InstancedMesh(asset.geometry, bodyTintMaterial(asset.material), MAX_CARS);
          // Created up front so the shader is compiled with instance colours.
          mesh.setColorAt(0, new THREE.Color(0xffffff));
          mesh.count = 0;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          // Instances move every frame; a stale bounding sphere would cull
          // cars that are in view.
          mesh.frustumCulled = false;
          mesh.name = `cars-${i}`;
          this.group.add(mesh);
          return mesh;
        });
        const lamp = new THREE.BoxGeometry(0.22, 0.1, 0.05);
        this.headlights = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial({ color: 0xfff1cc }), MAX_CARS * 2);
        this.taillights = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial({ color: 0xff2211 }), MAX_CARS * 2);
        for (const lights of [this.headlights, this.taillights]) {
          lights.count = 0;
          lights.frustumCulled = false;
          this.group.add(lights);
        }
        this.unsettled = true;
      })
      .catch((error) => console.error("Could not load the car models", error));
  }

  /** A new network (streets changed) restarts all traffic. */
  setNetwork(network: RoadNetwork | null): void {
    if (network === this.network) return;
    this.network = network;
    this.buildLenses();
    this.fill();
  }

  setActivity(traffic: number, dark: boolean): void {
    const changed = traffic !== this.target;
    this.target = traffic;
    if (dark !== this.dark) {
      this.dark = dark;
      this.unsettled = true;
    }
    // Moving traffic adjusts to a new level by itself (cars leave and
    // arrive); frozen traffic can't, so it's laid out afresh for the hour.
    if (this.network && (this.cars.length === 0 || (this.frozen && changed))) this.fill();
  }

  get carCount(): number {
    return this.cars.length;
  }

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  /** For frozen traffic: draw anything placed since last time, without
   * advancing. */
  settle(): void {
    if (!this.unsettled || !this.assets || !this.network) return;
    this.unsettled = false;
    this.draw();
    this.updateLenses();
  }

  /** Streets already partly busy rather than empty — and, from a fixed
   * seed, the same layout every time for the same streets and hour, so a
   * frozen scene loaded from a link is always the same picture. */
  private fill(): void {
    this.cars = [];
    this.random = seeded(hashString("traffic"));
    this.unsettled = true;
    const network = this.network;
    if (!network) return;
    const initial = this.targetCount();
    for (let i = 0; i < initial * 3 && this.cars.length < initial; i++) {
      const car = this.spawn();
      if (!car) continue;
      car.s = this.random() * car.track.length * 0.9;
      car.update(0, 0, network, () => false, Infinity);
      if (this.cars.every((other) => Math.hypot(other.x - car.x, other.z - car.z) > SPAWN_CLEARANCE_M)) this.cars.push(car);
    }
  }

  private buildLenses(): void {
    if (this.lenses) {
      this.group.remove(this.lenses);
      this.lenses.dispose();
      this.lenses = null;
    }
    const signals = this.network?.signals ?? [];
    if (signals.length === 0) return;
    const lenses = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.05, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      signals.length * 4 * LENS_ORDER.length
    );
    let index = 0;
    for (const signal of signals) {
      // Faces towards ±Z show phase 0 (traffic along Z sees them), faces
      // towards ±X phase 1.
      for (const [dx, dz] of [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ]) {
        this.rotation.setFromAxisAngle(this.up, Math.atan2(dx, dz));
        const reach = (dx !== 0 ? SIGNAL_HOUSING_HALF[0] : SIGNAL_HOUSING_HALF[1]) + 0.004;
        LENS_ORDER.forEach((_, k) => {
          this.position.set(
            signal.point[0] + dx * reach,
            this.terrain.heightAt(signal.point[0], signal.point[1]) + SIGNAL_HOUSING_Y + (1 - k) * SIGNAL_LENS_SPACING,
            signal.point[1] + dz * reach
          );
          this.matrix.compose(this.position, this.rotation, this.scale);
          lenses.setMatrixAt(index, this.matrix);
          lenses.setColorAt(index, LENS_COLOURS[LENS_ORDER[k]]);
          index++;
        });
      }
    }
    lenses.frustumCulled = false;
    lenses.name = "signal-lenses";
    this.lenses = lenses;
    this.group.add(lenses);
  }

  /** Lights the lens each face's phase is on, dims the other two. */
  private updateLenses(): void {
    const lenses = this.lenses;
    const network = this.network;
    if (!lenses || !network) return;
    const colour = new THREE.Color();
    let index = 0;
    for (const signal of network.signals) {
      const states = [signalState(signal.clock, 0, this.time), signalState(signal.clock, 1, this.time)];
      for (let face = 0; face < 4; face++) {
        const state = states[face < 2 ? 0 : 1];
        for (const lens of LENS_ORDER) {
          colour.copy(LENS_COLOURS[lens]);
          if (lens !== state) colour.multiplyScalar(LENS_OFF);
          lenses.setColorAt(index++, colour);
        }
      }
    }
    if (lenses.instanceColor) lenses.instanceColor.needsUpdate = true;
  }

  /** `pedestrians`: people who might be on a crossing. */
  update(delta: number, pedestrians: Point[]): void {
    const network = this.network;
    if (!network || !this.assets) return;
    delta = Math.min(delta, MAX_STEP_S);
    this.time += delta;

    const blockedCache = new Map<number, boolean>();
    const blocked = (index: number) => {
      let value = blockedCache.get(index);
      if (value === undefined) {
        const { a, b } = network.crossings[index];
        value = pedestrians.some((p) => distanceToSegment(p, a, b) <= CROSSING_CLEARANCE_M);
        blockedCache.set(index, value);
      }
      return value;
    };

    this.cars.forEach((car, index) => car.update(delta, this.time, network, blocked, this.gapAhead(car, index)));
    this.cars = this.cars.filter((car) => !car.finished);

    this.spawnCooldown -= delta;
    if (this.cars.length < this.targetCount() && this.spawnCooldown <= 0) {
      const car = this.spawn();
      if (car && this.cars.every((other) => Math.hypot(other.x - car.x, other.z - car.z) > SPAWN_CLEARANCE_M)) {
        this.cars.push(car);
      }
      this.spawnCooldown = SPAWN_INTERVAL_S;
    }
    this.draw();
    this.updateLenses();
    this.unsettled = false;
  }

  dispose(): void {
    this.disposed = true;
    for (const mesh of this.meshes) mesh.dispose();
    this.headlights?.dispose();
    this.taillights?.dispose();
    this.lenses?.dispose();
    this.group.clear();
  }

  private targetCount(): number {
    if (!this.network) return 0;
    return Math.round(this.target * Math.min(MAX_CARS, this.network.length / STREET_M_PER_CAR));
  }

  private spawn(): Car | null {
    const network = this.network!;
    const route = makeRoute(network, this.random);
    if (!route) return null;
    // By the model count, not the loaded assets, so the layout doesn't
    // depend on whether the models have finished loading.
    const model = Math.floor(this.random() * VEHICLE_FILES.length);
    const colour = new THREE.Color(BODY_COLOURS[Math.floor(this.random() * BODY_COLOURS.length)]);
    return new Car(model, colour, network, route);
  }

  /** Distance to the nearest car ahead in (roughly) the same lane. */
  private gapAhead(car: Car, index: number): number {
    const fx = Math.sin(car.yaw);
    const fz = Math.cos(car.yaw);
    let best = Infinity;
    this.cars.forEach((other, otherIndex) => {
      if (other === car) return;
      const dx = other.x - car.x;
      const dz = other.z - car.z;
      const along = dx * fx + dz * fz;
      const lateral = Math.abs(dx * fz - dz * fx);
      if (lateral > 1.6 || along > LOOK_AHEAD_M) return;
      if (Math.cos(other.yaw - car.yaw) < 0.3) return;
      // Within a car length (one just merged into the other's lane) "ahead"
      // is meaningless — each could see the other a few centimetres in front
      // and both would wait forever. Only the order decides: the later car
      // yields, the earlier one carries on.
      if (Math.abs(along) < CAR_LENGTH_M) {
        if (otherIndex < index) best = 0;
        return;
      }
      if (along > 0) best = Math.min(best, along);
    });
    return best;
  }

  private draw(): void {
    const counts = this.meshes.map(() => 0);
    let lights = 0;
    for (const car of this.cars) {
      const mesh = this.meshes[car.model];
      if (!mesh) continue;
      this.rotation.setFromAxisAngle(this.up, car.yaw + (MODEL_FORWARD > 0 ? 0 : Math.PI));
      const ground = this.terrain.heightAt(car.x, car.z);
      this.matrix.compose(this.position.set(car.x, ground, car.z), this.rotation, this.scale);
      mesh.setColorAt(counts[car.model], car.colour);
      mesh.setMatrixAt(counts[car.model]++, this.matrix);

      if (this.dark && this.headlights && this.taillights) {
        const size = this.assets![car.model].size;
        const fx = Math.sin(car.yaw);
        const fz = Math.cos(car.yaw);
        for (const side of [-1, 1]) {
          const sx = fz * side * size.x * 0.33;
          const sz = -fx * side * size.x * 0.33;
          this.matrix.compose(this.position.set(car.x + sx + fx * size.z * 0.5, ground + size.y * 0.45, car.z + sz + fz * size.z * 0.5), this.rotation, this.scale);
          this.headlights.setMatrixAt(lights, this.matrix);
          this.matrix.compose(this.position.set(car.x + sx - fx * size.z * 0.5, ground + size.y * 0.5, car.z + sz - fz * size.z * 0.5), this.rotation, this.scale);
          this.taillights.setMatrixAt(lights, this.matrix);
          lights++;
        }
      }
    }
    this.meshes.forEach((mesh, i) => {
      mesh.count = counts[i];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    for (const lamps of [this.headlights, this.taillights]) {
      if (!lamps) continue;
      lamps.count = lights;
      lamps.instanceMatrix.needsUpdate = true;
    }
  }
}
