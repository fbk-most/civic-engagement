/** The walkable network for people crossing the square: footpaths plus zebra
 * crossings, as a graph.
 *
 * OpenStreetMap footpaths are drawn as separate ways that often stop a few
 * metres short of each other — at a road, at the edge of a lawn — so taken
 * literally they fall apart into dozens of disconnected pieces. Two repairs
 * make them walkable:
 * - a path end within SNAP_M of another path is joined to it;
 * - each zebra crossing becomes a short path across the road along its
 *   stripes' axis, joined at both ends to the pavements it connects.
 * With those, most of each site's path length is one connected network
 * (about 94% of the path length in Trento, 80% in Bologna); pieces too short to be worth
 * walking are dropped.
 */

import type { DiscreteElement } from "../../api/types";
import { toLocal, type GeoAnchor } from "../geo";

const SNAP_M = 6;
const CROSSING_SNAP_M = 8;
// A crossing's walking axis runs a little past its first and last stripe,
// onto the kerb.
const CROSSING_OVERRUN_M = 1.5;
const MIN_COMPONENT_M = 100;
// Same radius the safety indicator counts as lit
// (civic_twin/domains/urban/parameters.py).
const LIT_RADIUS_M = 12;
// A path end this close to (or beyond) the site boundary is where people
// come in from, and leave to, the rest of the city.
const EXIT_BOUNDARY_M = 25;
// How far a destination (kiosk, playground...) may be from the network.
const DESTINATION_SNAP_M = 15;
const DESTINATION_TYPES = new Set<DiscreteElement["type"]>(["kiosk", "playground", "fitness_area", "pergola", "water_feature"]);

type Point = [number, number];

export interface NetworkEdge {
  to: number;
  length: number;
  /** 0-1: how much of the edge is within reach of a streetlight. */
  lit: number;
}

export interface WalkNetwork {
  nodes: Point[];
  edges: NetworkEdge[][];
  /** Connected pieces worth walking, each with its exits and destinations. */
  components: NetworkComponent[];
}

export interface NetworkComponent {
  length: number;
  nodes: number[];
  exits: number[];
  /** Node near a destination, with the point the walker faces on arrival. */
  destinations: { node: number; lookAt: Point }[];
}

export interface Polyline {
  points: Point[];
}

function lineStrings(geometry: GeoJSON.Geometry): GeoJSON.Position[][] {
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

/** The walking axis of a zebra crossing, from its stripes: the line through
 * the stripes' centres (stripes are laid out one after another across the
 * road). */
export function crossingAxis(element: DiscreteElement, anchor: GeoAnchor): Polyline | null {
  const centres = lineStrings(element.geometry)
    .filter((bar) => bar.length >= 2)
    .map((bar) => {
      const [ax, az] = toLocal(anchor, bar[0][0], bar[0][1]);
      const [bx, bz] = toLocal(anchor, bar[bar.length - 1][0], bar[bar.length - 1][1]);
      return [(ax + bx) / 2, (az + bz) / 2] as Point;
    });
  if (centres.length < 2) return null;
  const [sx, sz] = centres[0];
  const [ex, ez] = centres[centres.length - 1];
  const length = Math.hypot(ex - sx, ez - sz);
  if (length < 0.5) return null;
  const ux = (ex - sx) / length;
  const uz = (ez - sz) / length;
  return {
    points: [
      [sx - ux * CROSSING_OVERRUN_M, sz - uz * CROSSING_OVERRUN_M],
      [ex + ux * CROSSING_OVERRUN_M, ez + uz * CROSSING_OVERRUN_M],
    ],
  };
}

/** Closest point on segment ab to p, as the parameter along it. */
function projectOnSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return 0;
  return Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2));
}

function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Parameters along ab and cd where they cross, if they do. */
function intersect(a: Point, b: Point, c: Point, d: Point): [number, number] | null {
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
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [t, u];
}

function pointInPolygon(ring: Point[], [x, z]: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToRing(ring: Point[], p: Point): number {
  let best = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const t = projectOnSegment(p, ring[i - 1], ring[i]);
    const q = lerp(ring[i - 1], ring[i], t);
    best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1]));
  }
  return best;
}

interface Segment {
  a: Point;
  b: Point;
  /** Parameters (0-1) where this segment gets split into graph edges. */
  splits: number[];
}

/** Uniform grid over segments, so noding and snapping don't compare every
 * segment with every other. */
class SegmentGrid {
  private readonly cells = new Map<string, number[]>();
  private readonly size: number;

  constructor(segments: Segment[], size: number) {
    this.size = size;
    segments.forEach((segment, index) => {
      const [x0, x1] = [Math.min(segment.a[0], segment.b[0]), Math.max(segment.a[0], segment.b[0])];
      const [z0, z1] = [Math.min(segment.a[1], segment.b[1]), Math.max(segment.a[1], segment.b[1])];
      for (let cx = Math.floor(x0 / size); cx <= Math.floor(x1 / size); cx++) {
        for (let cz = Math.floor(z0 / size); cz <= Math.floor(z1 / size); cz++) {
          const key = `${cx},${cz}`;
          const cell = this.cells.get(key);
          if (cell) cell.push(index);
          else this.cells.set(key, [index]);
        }
      }
    });
  }

  near(p: Point, radius: number): Set<number> {
    const found = new Set<number>();
    for (let cx = Math.floor((p[0] - radius) / this.size); cx <= Math.floor((p[0] + radius) / this.size); cx++) {
      for (let cz = Math.floor((p[1] - radius) / this.size); cz <= Math.floor((p[1] + radius) / this.size); cz++) {
        for (const index of this.cells.get(`${cx},${cz}`) ?? []) found.add(index);
      }
    }
    return found;
  }
}

export function buildWalkNetwork(
  elements: DiscreteElement[],
  anchor: GeoAnchor,
  siteBoundary: GeoJSON.Polygon
): WalkNetwork {
  const polylines: Polyline[] = [];
  const crossingLines = new Set<Polyline>();
  for (const element of elements) {
    if (element.type === "path") {
      for (const line of lineStrings(element.geometry)) {
        if (line.length >= 2) polylines.push({ points: line.map(([lng, lat]) => toLocal(anchor, lng, lat)) });
      }
    } else if (element.type === "crossing") {
      const axis = crossingAxis(element, anchor);
      if (axis) {
        polylines.push(axis);
        crossingLines.add(axis);
      }
    }
  }

  const segments: Segment[] = [];
  const segmentLine: number[] = [];
  polylines.forEach((line, lineIndex) => {
    for (let i = 1; i < line.points.length; i++) {
      segments.push({ a: line.points[i - 1], b: line.points[i], splits: [0, 1] });
      segmentLine.push(lineIndex);
    }
  });
  const grid = new SegmentGrid(segments, 20);

  // Where paths cross each other without sharing a vertex.
  segments.forEach((segment, i) => {
    for (const j of grid.near(lerp(segment.a, segment.b, 0.5), Math.hypot(segment.b[0] - segment.a[0], segment.b[1] - segment.a[1]) / 2)) {
      if (j <= i || segmentLine[j] === segmentLine[i]) continue;
      const hit = intersect(segment.a, segment.b, segments[j].a, segments[j].b);
      if (!hit) continue;
      segment.splits.push(hit[0]);
      segments[j].splits.push(hit[1]);
    }
  });

  // Loose ends joined to the nearest other path within reach.
  const connectors: Segment[] = [];
  polylines.forEach((line, lineIndex) => {
    const reach = crossingLines.has(line) ? CROSSING_SNAP_M : SNAP_M;
    for (const end of [line.points[0], line.points[line.points.length - 1]]) {
      let best: { segment: number; t: number; distance: number } | null = null;
      for (const j of grid.near(end, reach)) {
        if (segmentLine[j] === lineIndex) continue;
        const t = projectOnSegment(end, segments[j].a, segments[j].b);
        const q = lerp(segments[j].a, segments[j].b, t);
        const distance = Math.hypot(q[0] - end[0], q[1] - end[1]);
        if (distance <= reach && (!best || distance < best.distance)) best = { segment: j, t, distance };
      }
      if (!best) continue;
      // Split the other path there even when the end already touches it:
      // a way that stops partway along another (rather than at one of its
      // vertices) otherwise shares no node with it.
      segments[best.segment].splits.push(best.t);
      connectors.push({ a: end, b: lerp(segments[best.segment].a, segments[best.segment].b, best.t), splits: [0, 1] });
    }
  });

  // Graph: nodes keyed by position (to 5 cm), so ways that share a vertex in
  // OSM, and the split points above, all meet at the same node.
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
  const edges: NetworkEdge[][] = [];
  const lights = elements
    .filter((e) => e.type === "streetlight" && e.geometry.type === "Point")
    .map((e) => toLocal(anchor, ...((e.geometry as GeoJSON.Point).coordinates as [number, number])));
  const isLit = (p: Point) => lights.some(([lx, lz]) => (lx - p[0]) ** 2 + (lz - p[1]) ** 2 <= LIT_RADIUS_M ** 2);
  const addEdge = (p: Point, q: Point) => {
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (length < 0.01) return;
    const i = nodeAt(p);
    const j = nodeAt(q);
    if (i === j) return;
    // Sampled every few metres: a long edge is often lit at one end only.
    const samples = Math.max(2, Math.ceil(length / 4) + 1);
    let litSamples = 0;
    for (let k = 0; k < samples; k++) if (isLit(lerp(p, q, k / (samples - 1)))) litSamples++;
    const lit = litSamples / samples;
    (edges[i] ??= []).push({ to: j, length, lit });
    (edges[j] ??= []).push({ to: i, length, lit });
  };
  for (const segment of [...segments, ...connectors]) {
    const splits = [...new Set(segment.splits)].sort((x, y) => x - y);
    for (let k = 1; k < splits.length; k++) {
      addEdge(lerp(segment.a, segment.b, splits[k - 1]), lerp(segment.a, segment.b, splits[k]));
    }
  }
  for (let i = 0; i < nodes.length; i++) edges[i] ??= [];

  // Connected pieces, keeping those worth walking.
  const boundary = (siteBoundary.coordinates[0] ?? []).map(([lng, lat]) => toLocal(anchor, lng, lat));
  const destinations = elements
    .filter((e) => DESTINATION_TYPES.has(e.type) && e.geometry.type === "Point")
    .map((e) => toLocal(anchor, ...((e.geometry as GeoJSON.Point).coordinates as [number, number])));
  const seen = new Uint8Array(nodes.length);
  const components: NetworkComponent[] = [];
  for (let start = 0; start < nodes.length; start++) {
    if (seen[start]) continue;
    const members: number[] = [];
    let length = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const node = stack.pop()!;
      members.push(node);
      for (const edge of edges[node]) {
        length += edge.length / 2;
        if (!seen[edge.to]) {
          seen[edge.to] = 1;
          stack.push(edge.to);
        }
      }
    }
    if (length < MIN_COMPONENT_M) continue;

    const deadEnds = members.filter((node) => edges[node].length === 1);
    let exits = deadEnds.filter(
      (node) =>
        boundary.length < 3 ||
        !pointInPolygon(boundary, nodes[node]) ||
        distanceToRing(boundary, nodes[node]) <= EXIT_BOUNDARY_M
    );
    // A piece entirely inside the site (a park loop): people still have to
    // come and go somewhere, so use its dead ends, or failing those its
    // outermost nodes.
    if (exits.length < 2) exits = deadEnds;
    if (exits.length < 2) {
      const [cx, cz] = members.reduce(([x, z], node) => [x + nodes[node][0] / members.length, z + nodes[node][1] / members.length], [0, 0]);
      exits = [...members].sort((a, b) => Math.hypot(nodes[b][0] - cx, nodes[b][1] - cz) - Math.hypot(nodes[a][0] - cx, nodes[a][1] - cz)).slice(0, 2);
    }

    const componentDestinations: NetworkComponent["destinations"] = [];
    for (const target of destinations) {
      let best = -1;
      let bestDistance = DESTINATION_SNAP_M;
      for (const node of members) {
        const distance = Math.hypot(nodes[node][0] - target[0], nodes[node][1] - target[1]);
        if (distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
      if (best >= 0) componentDestinations.push({ node: best, lookAt: target });
    }
    components.push({ length, nodes: members, exits, destinations: componentDestinations });
  }

  return { nodes, edges, components };
}

/** Shortest route between two nodes, as node indices. At night, the unlit
 * part of each stretch counts as `darkPenalty` times longer: people prefer
 * lit paths. */
export function findRoute(network: WalkNetwork, from: number, to: number, darkPenalty: number): number[] | null {
  if (from === to) return null;
  const cost = new Float64Array(network.nodes.length).fill(Infinity);
  const previous = new Int32Array(network.nodes.length).fill(-1);
  const heap = new MinHeap();
  cost[from] = 0;
  heap.push(from, 0);
  while (heap.size > 0) {
    const [node, nodeCost] = heap.pop();
    if (node === to) break;
    if (nodeCost > cost[node]) continue;
    for (const edge of network.edges[node]) {
      const next = nodeCost + edge.length * (edge.lit + (1 - edge.lit) * darkPenalty);
      if (next < cost[edge.to]) {
        cost[edge.to] = next;
        previous[edge.to] = node;
        heap.push(edge.to, next);
      }
    }
  }
  if (previous[to] === -1) return null;
  const route = [to];
  while (route[route.length - 1] !== from) route.push(previous[route[route.length - 1]]);
  return route.reverse();
}

class MinHeap {
  private readonly items: [number, number][] = [];

  get size(): number {
    return this.items.length;
  }

  push(value: number, priority: number): void {
    const items = this.items;
    items.push([value, priority]);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent][1] <= items[i][1]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): [number, number] {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < items.length && items[l][1] < items[smallest][1]) smallest = l;
        if (r < items.length && items[r][1] < items[smallest][1]) smallest = r;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}
