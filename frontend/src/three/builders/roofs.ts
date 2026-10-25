/** Roof massing on top of a building's wall extrusion (see `buildings.ts`).
 *
 * Real geometry (hip/gable/pyramidal/skillion) gets built over the
 * footprint's own oriented bounding box when the footprint is close to it;
 * an L-, T- or U-shaped one gets a gabled or hipped roof over each of its
 * wings (see roofParts.ts). A footprint that is neither (curved, slanting
 * walls, a compound of many parts), or a shape with no geometry here,
 * falls back to flat-with-parapet: a hip roof built over just the bounding
 * rectangle would overhang empty space at the notch, which reads as more
 * broken than a flat roof.
 */

import * as THREE from "three";
import type { GeoAnchor } from "../geo";
import { geometryToShapes, outerRingsXZ, ringXZToShape } from "../shapes";
import { footprintRects, type Rect } from "./roofParts";

const PARAPET_HEIGHT_M = 0.35;

// How far a pitched roof reaches past the walls, and how thick it is.
const OVERHANG_M = 0.6;
const ROOF_THICKNESS_M = 0.2;

// A pitched roof only gets real geometry when the footprint fills at least
// this fraction of its own oriented bounding box. Chosen from this
// baseline's actual buildings: genuinely rectangular ones (simple boxes,
// occasional single small bay) mostly land above 0.85; true L/T/cross shapes
// sit at 0.36-0.78 (see the exploration that picked this threshold).
const RECTANGULARITY_THRESHOLD = 0.85;
// A footprint that rectangular is one block, under one roof, unless it's a
// block and a wing (a church's nave and its narrower apse, a house and its
// bay), each at least this wide: under one roof, the wing's walls would stand
// metres inside its eaves. A narrower strip is the survey's, or a step in a
// wall: the roof's overhang covers it.
const MIN_WING_M = 3;

// Fallback rise for a real OSM `roof:shape` tag with no LiDAR ridge height
// behind it (a handful of buildings) — a moderate ~35° pitch look, not a
// measurement.
const DEFAULT_RISE_FRACTION = 0.35;
// The steepest a roof gets (rise over half its width: 45°), whatever its
// ridge height: a LiDAR ridge over a narrow footprint may be a taller
// neighbour's.
const MAX_PITCH = 1;

type Point = [number, number, number];

function polygonArea(points: THREE.Vector2[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += points[j].x * points[i].y - points[i].x * points[j].y;
  }
  return Math.abs(sum) / 2;
}

function convexHull(points: THREE.Vector2[]): THREE.Vector2[] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: THREE.Vector2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: THREE.Vector2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

interface OrientedBox {
  angle: number;
  center: THREE.Vector2;
  across: number; // the shorter side
  along: number; // the longer side — roof builders below put the ridge along this axis
}

/** Rotating calipers over the hull's own edges — the minimum-area oriented
 * box always has one side flush with a hull edge, so testing every edge
 * angle is exhaustive, not a heuristic. */
function minAreaOBB(hull: THREE.Vector2[]): OrientedBox | null {
  if (hull.length < 3) return null;
  let best: { area: number; angle: number; minX: number; maxX: number; minZ: number; maxZ: number } | null = null;

  for (let i = 0; i < hull.length; i++) {
    const p0 = hull[i];
    const p1 = hull[(i + 1) % hull.length];
    const edgeAngle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const cos = Math.cos(-edgeAngle);
    const sin = Math.sin(-edgeAngle);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of hull) {
      const rx = p.x * cos - p.y * sin;
      const rz = p.x * sin + p.y * cos;
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx);
      minZ = Math.min(minZ, rz);
      maxZ = Math.max(maxZ, rz);
    }
    const area = (maxX - minX) * (maxZ - minZ);
    if (!best || area < best.area) best = { area, angle: edgeAngle, minX, maxX, minZ, maxZ };
  }
  if (!best) return null;

  const cx = (best.minX + best.maxX) / 2;
  const cz = (best.minZ + best.maxZ) / 2;
  const cos = Math.cos(best.angle);
  const sin = Math.sin(best.angle);
  const center = new THREE.Vector2(cos * cx - sin * cz, sin * cx + cos * cz);

  let across = best.maxX - best.minX;
  let along = best.maxZ - best.minZ;
  let angle = best.angle;
  // Canonicalize so `along` (used as the ridge axis below) is always the
  // longer side, regardless of which hull edge happened to produce the
  // minimum box.
  if (across > along) {
    angle -= Math.PI / 2;
    [across, along] = [along, across];
  }
  return { angle, center, across, along };
}

/** The box with its `along` (the ridge's axis) the side closer to a
 * bearing: the other one if that's the short side. */
function turnedTo(box: OrientedBox, bearingDeg: number): OrientedBox {
  const bearing = (bearingDeg * Math.PI) / 180;
  // The bearing in the local frame (x east, z south); the ridge's axis as
  // `placeInWorld` puts a roof's local z.
  const [bx, bz] = [Math.sin(bearing), -Math.cos(bearing)];
  const alongness = Math.abs(-Math.sin(box.angle) * bx + Math.cos(box.angle) * bz);
  if (alongness >= Math.SQRT1_2) return box;
  return { angle: box.angle - Math.PI / 2, center: box.center, across: box.along, along: box.across };
}

/** Rotates+translates a locally-built roof geometry (ridge along local z,
 * see the builders below) into world XZ. Written out explicitly rather than
 * via `BufferGeometry.rotateY`/`.translate` so the rotation direction is
 * guaranteed to match the convention `minAreaOBB` above computes `angle` in
 * — the two were derived together algebraically, not independently guessed
 * and hoped to agree. */
function placeInWorld(geom: THREE.BufferGeometry, angle: number, center: THREE.Vector2): void {
  const position = geom.getAttribute("position") as THREE.BufferAttribute;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let i = 0; i < position.count; i++) {
    const lx = position.getX(i);
    const ly = position.getY(i);
    const lz = position.getZ(i);
    position.setXYZ(i, center.x + cos * lx - sin * lz, ly, center.y + sin * lx + cos * lz);
  }
  position.needsUpdate = true;
}

function toGeometry(triangles: Point[]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const p of triangles) positions.push(...p);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geom;
}

/** A roof's sloped faces, and its vertical end walls (a gable's, a lean-to's
 * sides), in the roof's local frame: the walls stand across the ridge, at
 * z = ±along/2. */
interface RoofFaces {
  slopes: Point[];
  walls: Point[];
}

/** The walls under a roof (placed: see `placeInWorld`), textured as the
 * walls below them are by three's ExtrudeGeometry, so that the windows run
 * on: u the world's x along a wall running more east-west than north-south,
 * else the shape's y (−z, see shapes.ts); v 1 − the height above the
 * building's base. In metres (see facade.ts). */
function setWallUVs(geom: THREE.BufferGeometry): void {
  const position = geom.getAttribute("position") as THREE.BufferAttribute;
  const uvs: number[] = [];
  for (let i = 0; i < position.count; i += 3) {
    // The triangle's horizontal extent, along x and along z.
    const xs = [0, 1, 2].map((k) => position.getX(i + k));
    const zs = [0, 1, 2].map((k) => position.getZ(i + k));
    const eastWest = Math.max(...xs) - Math.min(...xs) > Math.max(...zs) - Math.min(...zs);
    for (let k = 0; k < 3; k++) uvs.push(eastWest ? xs[k] : -zs[k], 1 - position.getY(i + k));
  }
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
}

/** Hip roof (ridgeLen < along), gable (ridgeLen === along, the end faces
 * degenerate to vertical gable-wall triangles) and pyramidal (ridgeLen 0,
 * both ridge points coincide at a single apex) are all the same shape family
 * — see the module docstring's neighbouring comment in buildRoof for which
 * `roof_shape` maps to which `ridgeLen`. The slopes reach `OVERHANG_M` past
 * the walls, down their own planes (a gable's ends level, as a verge); the
 * eaves all at one height, so a hip's ends, steeper or not, reach out as far
 * as that takes. These are the roof's underside: see `slab`. */
function buildHipFamilyRoof(across: number, along: number, eaveY: number, ridgeY: number, ridgeLen: number): RoofFaces {
  const hx = across / 2;
  const hz = along / 2;
  const hr = Math.min(ridgeLen, along) / 2;
  const rise = ridgeY - eaveY;
  const gable = hr >= hz - 1e-6;

  const drop = (rise / hx) * OVERHANG_M;
  const ex = hx + OVERHANG_M;
  const ez = gable ? hz + OVERHANG_M : hz + drop / (rise / (hz - hr));
  const ey = eaveY - drop;
  const a: Point = [-ex, ey, -ez];
  const b: Point = [ex, ey, -ez];
  const c: Point = [ex, ey, ez];
  const d: Point = [-ex, ey, ez];

  if (hr <= 1e-6) {
    const apex: Point = [0, ridgeY, 0];
    return { slopes: [a, d, apex, b, apex, c, a, apex, b, d, c, apex], walls: [] };
  }

  const er = gable ? ez : hr;
  const r1: Point = [0, ridgeY, -er];
  const r2: Point = [0, ridgeY, er];
  const sides: Point[] = [
    a, d, r2, a, r2, r1, // west slope
    b, r1, r2, b, r2, c, // east slope
  ];
  if (!gable) {
    return {
      slopes: [
        ...sides,
        a, r1, b, // south hip end
        d, c, r2, // north hip end
      ],
      walls: [],
    };
  }
  // A gable's ends are upright: walls, at the walls' line, under the roof.
  return {
    slopes: sides,
    walls: [
      [-hx, eaveY, -hz], [0, ridgeY, -hz], [hx, eaveY, -hz],
      [-hx, eaveY, hz], [hx, eaveY, hz], [0, ridgeY, hz],
    ],
  };
}

/** Single sloped plane from the low (`eaveY`) long edge to the high
 * (`ridgeY`) long edge — a lean-to roof, no ridge line — reaching
 * `OVERHANG_M` past the walls; under it, the walls between the eave and the
 * slope (the two ends, and the high side). */
function buildSkillionRoof(across: number, along: number, eaveY: number, ridgeY: number): RoofFaces {
  const hx = across / 2;
  const hz = along / 2;
  const k = (ridgeY - eaveY) / across;
  const ex = hx + OVERHANG_M;
  const ez = hz + OVERHANG_M;
  const low = eaveY - k * OVERHANG_M;
  const high = ridgeY + k * OVERHANG_M;
  const a: Point = [-ex, low, -ez];
  const b: Point = [ex, high, -ez];
  const c: Point = [ex, high, ez];
  const d: Point = [-ex, low, ez];

  const wa: Point = [-hx, eaveY, -hz];
  const wb: Point = [hx, ridgeY, -hz];
  const wc: Point = [hx, ridgeY, hz];
  const wd: Point = [-hx, eaveY, hz];
  const wa2: Point = [hx, eaveY, -hz];
  const wd2: Point = [hx, eaveY, hz];
  return {
    slopes: [a, d, c, a, c, b], // sloped top
    walls: [
      wa, wb, wa2, // south end wall
      wd, wd2, wc, // north end wall
      wa2, wb, wc, wa2, wc, wd2, // the high side
    ],
  };
}

/** Each triangle turned to face away from the roof's vertical axis (x = z
 * = 0, the roof's local frame): for walls, and a slab's edges. */
function facingOut(triangles: Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const [p, q, r] = [triangles[i], triangles[i + 1], triangles[i + 2]];
    const [ux, uy, uz] = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const [vx, vy, vz] = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    // The normal's horizontal part (x, z), against the way out from the axis.
    const nx = uy * vz - uz * vy;
    const nz = ux * vy - uy * vx;
    const mx = (p[0] + q[0] + r[0]) / 3;
    const mz = (p[2] + q[2] + r[2]) / 3;
    out.push(...(nx * mx + nz * mz >= 0 ? [p, q, r] : [p, r, q]));
  }
  return out;
}

/** A roof's faces (its underside) as a slab `ROOF_THICKNESS_M` thick: the
 * top, raised by that; and the underside, facing down, with the edges all
 * round. */
function slab(slopes: Point[]): { top: Point[]; under: Point[] } {
  const up = (p: Point): Point => [p[0], p[1] + ROOF_THICKNESS_M, p[2]];
  const top = slopes.map(up);
  const under: Point[] = [];
  for (let i = 0; i < slopes.length; i += 3) under.push(slopes[i], slopes[i + 2], slopes[i + 1]);

  // The edges: those of one face only.
  const key = (p: Point) => p.map((v) => v.toFixed(4)).join(",");
  const count = new Map<string, number>();
  const edges: [Point, Point][] = [];
  for (let i = 0; i < slopes.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const [p, q] = [slopes[i + k], slopes[i + ((k + 1) % 3)]];
      const id = [key(p), key(q)].sort().join("|");
      count.set(id, (count.get(id) ?? 0) + 1);
      edges.push([p, q]);
    }
  }
  const rim: Point[] = [];
  for (const [p, q] of edges) {
    if (count.get([key(p), key(q)].sort().join("|")) !== 1) continue;
    rim.push(p, q, up(q), p, up(q), up(p));
  }
  under.push(...facingOut(rim));
  return { top, under };
}

/** The roof sitting on top of a building's wall extrusion (which already
 * caps the footprint flat at `eaveY` — see buildings.ts — so every shape
 * below only has to cover *above* that, not close its own underside).
 * Returns null only when the footprint itself is unusable (no material to
 * attach to happens in the caller). A gable's or a lean-to's end walls get
 * `wallMaterial`, the walls' below. The ridge runs along the footprint's
 * long side, or across it if `ridgeBearingDeg` (degrees from north, as read
 * off the LiDAR: see the backend's lidar.py) says so. */
export function buildRoof(
  anchor: GeoAnchor,
  geometry: GeoJSON.Geometry,
  eaveY: number,
  roofShape: string | undefined,
  ridgeHeightM: number | undefined,
  ridgeBearingDeg: number | undefined,
  material: THREE.Material,
  wallMaterial: THREE.Material
): THREE.Object3D | null {
  const buildFlatParapet = (): THREE.Object3D | null => {
    const shapes = geometryToShapes(anchor, geometry);
    if (shapes.length === 0) return null;
    const geom = new THREE.ExtrudeGeometry(shapes, { depth: PARAPET_HEIGHT_M, bevelEnabled: false });
    geom.rotateX(-Math.PI / 2);
    geom.translate(0, eaveY, 0);
    const mesh = new THREE.Mesh(geom, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  const shape = (roofShape ?? "flat").toLowerCase();
  if (shape === "flat") return buildFlatParapet();

  const rings = outerRingsXZ(anchor, geometry);
  if (rings.length !== 1) return buildFlatParapet(); // a MultiPolygon building has no single ridge line to speak of

  const found = minAreaOBB(convexHull(rings[0]));
  if (!found || found.across <= 0 || found.along <= 0) return buildFlatParapet();
  const obb = ridgeBearingDeg === undefined ? found : turnedTo(found, ridgeBearingDeg);

  // Wings: a roof each, of one pitch (the LiDAR's ridge is the largest
  // part's), so that the narrower wings' ridges are lower.
  const plan = wings(anchor, geometry, shape);
  if (!plan) {
    const rectangularity = polygonArea(rings[0]) / (obb.across * obb.along);
    if (rectangularity < RECTANGULARITY_THRESHOLD) return buildFlatParapet();
    const rise = ridgeHeightM !== undefined ? ridgeHeightM - eaveY : Math.min(obb.across, obb.along) * DEFAULT_RISE_FRACTION;
    const ridgeY = eaveY + Math.max(0.3, Math.min(rise, (MAX_PITCH * obb.across) / 2));
    return pitchedRoof(obb, shape, eaveY, ridgeY, material, wallMaterial) ?? buildFlatParapet();
  }
  const boxes = plan.rects.roofs.map((r) => boxOf(r, plan.frame));
  const main = boxes.reduce((a, b) => (a.across * a.along >= b.across * b.along ? a : b));
  const pitch = Math.min(MAX_PITCH, ridgeHeightM !== undefined ? (ridgeHeightM - eaveY) / (main.across / 2) : 2 * DEFAULT_RISE_FRACTION);
  const roof = new THREE.Group();
  for (const box of boxes) {
    const part = pitchedRoof(box, shape, eaveY, eaveY + Math.max(0.3, (pitch * box.across) / 2), material, wallMaterial);
    if (part) roof.add(part);
  }
  return roof;
}

/** A footprint as wings (see roofParts.ts), if it is one and its roof is
 * one a footprint of wings may have: one polygon without a courtyard, not
 * rectangular (that's one roof) unless a wing of it is wide enough to be one
 * (see `MIN_WING_M`). */
function wings(
  anchor: GeoAnchor,
  geometry: GeoJSON.Geometry,
  shape: string
): { frame: OrientedBox; rects: { walls: Rect[]; roofs: Rect[] } } | null {
  if (!WINGED_SHAPES.has(shape) || geometry.type !== "Polygon" || geometry.coordinates.length !== 1) return null;
  const rings = outerRingsXZ(anchor, geometry);
  if (rings.length !== 1) return null;
  const frame = minAreaOBB(convexHull(rings[0]));
  if (!frame || frame.across <= 0 || frame.along <= 0) return null;
  const rects = footprintRects(rings[0], frame.angle, frame.center);
  if (!rects) return null;
  if (polygonArea(rings[0]) / (frame.across * frame.along) >= RECTANGULARITY_THRESHOLD) {
    const narrow = (r: Rect) => Math.min(r.x1 - r.x0, r.z1 - r.z0) < MIN_WING_M;
    if (rects.walls.length < 2 || rects.walls.some(narrow)) return null;
  }
  return { frame, rects };
}

/** The outline a building's walls stand on: its footprint's, or, for a
 * footprint of wings, the squared-off rectangles its roofs stand on (see
 * roofParts.ts). */
export function wallShapes(anchor: GeoAnchor, geometry: GeoJSON.Geometry, roofShape: string | undefined): THREE.Shape[] {
  const plan = wings(anchor, geometry, (roofShape ?? "flat").toLowerCase());
  if (!plan) return geometryToShapes(anchor, geometry);
  return plan.rects.walls.map((r) => {
    const box = boxOf(r, plan.frame);
    const cos = Math.cos(box.angle);
    const sin = Math.sin(box.angle);
    const corner = (lx: number, lz: number) =>
      new THREE.Vector2(box.center.x + cos * lx - sin * lz, box.center.y + sin * lx + cos * lz);
    const [hx, hz] = [box.across / 2, box.along / 2];
    return ringXZToShape([corner(-hx, -hz), corner(hx, -hz), corner(hx, hz), corner(-hx, hz)]);
  });
}

/** The roofs a footprint of wings may have (see roofParts.ts); any other
 * shape keeps a flat roof on one. */
const WINGED_SHAPES = new Set(["gabled", "hipped", "pitched"]);

/** A rectangle in the frame of `frame` (see roofParts.ts) as a box of its
 * own, its `along` the longer side. */
function boxOf(r: Rect, frame: OrientedBox): OrientedBox {
  const cos = Math.cos(frame.angle);
  const sin = Math.sin(frame.angle);
  const mx = (r.x0 + r.x1) / 2;
  const mz = (r.z0 + r.z1) / 2;
  const center = new THREE.Vector2(frame.center.x + cos * mx - sin * mz, frame.center.y + sin * mx + cos * mz);
  const across = r.x1 - r.x0;
  const along = r.z1 - r.z0;
  return across <= along
    ? { angle: frame.angle, center, across, along }
    : { angle: frame.angle - Math.PI / 2, center, across: along, along: across };
}

/** A pitched roof over a rectangle: its slopes, as a slab, and the walls
 * under it; null for a shape with no geometry here. */
function pitchedRoof(
  obb: OrientedBox,
  shape: string,
  eaveY: number,
  ridgeY: number,
  material: THREE.Material,
  wallMaterial: THREE.Material
): THREE.Group | null {
  let faces: RoofFaces;
  switch (shape) {
    case "skillion":
      faces = buildSkillionRoof(obb.across, obb.along, eaveY, ridgeY);
      break;
    case "gabled":
      faces = buildHipFamilyRoof(obb.across, obb.along, eaveY, ridgeY, obb.along);
      break;
    case "pyramidal":
      faces = buildHipFamilyRoof(obb.across, obb.along, eaveY, ridgeY, 0);
      break;
    case "hipped":
    case "pitched":
      faces = buildHipFamilyRoof(obb.across, obb.along, eaveY, ridgeY, Math.max(obb.along - obb.across, 0));
      break;
    default:
      // An OSM roof:shape this baseline doesn't have an example of (dome,
      // mansard, gambrel, half-hipped, ...) — no matching geometry, and
      // flat-with-parapet is a safer wrong answer than guessing a shape.
      return null;
  }

  const roof = new THREE.Group();
  const { top, under } = slab(faces.slopes);
  const parts: [THREE.BufferGeometry, THREE.Material, boolean][] = [
    [toGeometry(top), material, false],
    [toGeometry(under), material, true],
  ];
  if (faces.walls.length > 0) parts.push([toGeometry(facingOut(faces.walls)), wallMaterial, false]);
  for (const [geom, partMaterial, soffit] of parts) {
    placeInWorld(geom, obb.angle, obb.center);
    if (partMaterial === wallMaterial) setWallUVs(geom);
    geom.computeVertexNormals();
    const mesh = new THREE.Mesh(geom, partMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The underside and the edges: wood, whatever covers the top (see
    // buildings.ts).
    mesh.userData.soffit = soffit;
    roof.add(mesh);
  }
  return roof;
}
