/** Roof massing on top of a building's wall extrusion (see `buildings.ts`).
 *
 * Real geometry (hip/gable/pyramidal/skillion) only gets built when the
 * footprint is close to its own oriented bounding box — an L/T/cross-shaped
 * footprint (about 30% of the current baseline, including both churches)
 * would need a rectilinear straight-skeleton to roof correctly; a hip roof
 * built over just the bounding rectangle would overhang empty space at the
 * notch, which reads as more broken than a flat roof. That's a documented
 * gap, not a silent one: those footprints fall back to flat-with-parapet
 * even when `roof_shape` says otherwise.
 */

import * as THREE from "three";
import type { GeoAnchor } from "../geo";
import { geometryToShapes, outerRingsXZ } from "../shapes";

const PARAPET_HEIGHT_M = 0.35;

// A pitched roof only gets real geometry when the footprint fills at least
// this fraction of its own oriented bounding box. Chosen from this
// baseline's actual buildings: genuinely rectangular ones (simple boxes,
// occasional single small bay) mostly land above 0.85; true L/T/cross shapes
// sit at 0.36-0.78 (see the exploration that picked this threshold).
const RECTANGULARITY_THRESHOLD = 0.85;

// Fallback rise for a real OSM `roof:shape` tag with no LiDAR ridge height
// behind it (a handful of buildings) — a moderate ~35° pitch look, not a
// measurement.
const DEFAULT_RISE_FRACTION = 0.35;

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

/** Hip roof (ridgeLen < along), gable (ridgeLen === along, the end faces
 * degenerate to vertical gable-wall triangles) and pyramidal (ridgeLen 0,
 * both ridge points coincide at a single apex) are all the same shape family
 * — see the module docstring's neighbouring comment in buildRoof for which
 * `roof_shape` maps to which `ridgeLen`. Vertex winding for each face was
 * derived by hand (cross-product sign check) rather than guessed; see the
 * git history for that derivation if this ever needs to change. */
function buildHipFamilyRoof(across: number, along: number, eaveY: number, ridgeY: number, ridgeLen: number): THREE.BufferGeometry {
  const hx = across / 2;
  const hz = along / 2;
  const hr = Math.min(ridgeLen, along) / 2;

  const a: Point = [-hx, eaveY, -hz];
  const b: Point = [hx, eaveY, -hz];
  const c: Point = [hx, eaveY, hz];
  const d: Point = [-hx, eaveY, hz];

  if (hr <= 1e-6) {
    const apex: Point = [0, ridgeY, 0];
    return toGeometry([a, d, apex, b, apex, c, a, apex, b, d, c, apex]);
  }

  const r1: Point = [0, ridgeY, -hr];
  const r2: Point = [0, ridgeY, hr];
  return toGeometry([
    a, d, r2, a, r2, r1, // west slope
    b, r1, r2, b, r2, c, // east slope
    a, r1, b, // south hip end
    d, c, r2, // north hip end
  ]);
}

/** Single sloped plane from the low (`eaveY`) long edge to the high
 * (`ridgeY`) long edge — a lean-to roof, no ridge line. */
function buildSkillionRoof(across: number, along: number, eaveY: number, ridgeY: number): THREE.BufferGeometry {
  const hx = across / 2;
  const hz = along / 2;
  const a: Point = [-hx, eaveY, -hz];
  const b: Point = [hx, ridgeY, -hz];
  const c: Point = [hx, ridgeY, hz];
  const d: Point = [-hx, eaveY, hz];
  const a2: Point = [hx, eaveY, -hz];
  const d2: Point = [hx, eaveY, hz];
  return toGeometry([
    a, d, c, a, c, b, // sloped top
    a, b, a2, // south end wall
    d, d2, c, // north end wall
  ]);
}

/** The roof sitting on top of a building's wall extrusion (which already
 * caps the footprint flat at `eaveY` — see buildings.ts — so every shape
 * below only has to cover *above* that, not close its own underside).
 * Returns null only when the footprint itself is unusable (no material to
 * attach to happens in the caller). */
export function buildRoof(
  anchor: GeoAnchor,
  geometry: GeoJSON.Geometry,
  eaveY: number,
  roofShape: string | undefined,
  ridgeHeightM: number | undefined,
  material: THREE.Material
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

  const obb = minAreaOBB(convexHull(rings[0]));
  if (!obb || obb.across <= 0 || obb.along <= 0) return buildFlatParapet();

  const rectangularity = polygonArea(rings[0]) / (obb.across * obb.along);
  if (rectangularity < RECTANGULARITY_THRESHOLD) return buildFlatParapet();

  const ridgeY = Math.max(eaveY + 0.3, ridgeHeightM ?? eaveY + Math.min(obb.across, obb.along) * DEFAULT_RISE_FRACTION);

  let geom: THREE.BufferGeometry;
  switch (shape) {
    case "skillion":
      geom = buildSkillionRoof(obb.across, obb.along, eaveY, ridgeY);
      break;
    case "gabled":
      geom = buildHipFamilyRoof(obb.across, obb.along, eaveY, ridgeY, obb.along);
      break;
    case "pyramidal":
      geom = buildHipFamilyRoof(obb.across, obb.along, eaveY, ridgeY, 0);
      break;
    case "hipped":
    case "pitched":
      geom = buildHipFamilyRoof(obb.across, obb.along, eaveY, ridgeY, Math.max(obb.along - obb.across, 0));
      break;
    default:
      // An OSM roof:shape this baseline doesn't have an example of (dome,
      // mansard, gambrel, half-hipped, ...) — no matching geometry, and
      // flat-with-parapet is a safer wrong answer than guessing a shape.
      return buildFlatParapet();
  }

  placeInWorld(geom, obb.angle, obb.center);
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(geom, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
