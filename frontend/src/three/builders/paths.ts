import * as THREE from "three";
import type { DiscreteElement } from "../../api/types";
import { toLocal, type GeoAnchor } from "../geo";
import { isPaintedPath, type MaterialLibrary } from "../materials";
import { drapeGeometry, PATH_HEIGHT_M } from "../shapes";
import type { Terrain } from "../terrain";

/** How far a miter join is allowed to stretch before it's cut back to a butt
 * join. Without a limit, a near-doubled-back path (the baseline has a few)
 * throws a spike hundreds of metres across the square. */
const MITER_LIMIT = 3;

const DEFAULT_WIDTH_M = 2;
const MIN_PATH_WIDTH_M = 0.5;

// Paint markings (crossing stripes, lane lines: path materials marked
// `painted`, see materials.ts's Surface) ride on top of a street
// ribbon at the same nominal height. A depth bias alone (materials.ts's
// polygonOffset) wasn't enough to stop them flickering against the asphalt
// at street-level viewing distance, so they're also physically lifted a
// couple of centimetres — invisible at any real viewing angle, but a real
// depth separation. They're also exempt from the path width floor: a 0.12m
// lane line clamped to 0.5m read as a smeared band, not a painted line.
const MARKING_LIFT_M = 0.02;
const MIN_MARKING_WIDTH_M = 0.05;

type Point2 = { x: number; z: number };

/** Above the ground: every ribbon of a material at the same height. */
function ribbonHeight(material: string): number {
  return isPaintedPath(material) ? PATH_HEIGHT_M + MARKING_LIFT_M : PATH_HEIGHT_M;
}

function lineStrings(geometry: GeoJSON.Geometry): GeoJSON.Position[][] {
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function toLocalPoints(anchor: GeoAnchor, coords: GeoJSON.Position[]): Point2[] {
  const points: Point2[] = [];
  for (const [lng, lat] of coords) {
    const [x, z] = toLocal(anchor, lng, lat);
    // Consecutive duplicates give a zero-length segment, whose normal is NaN
    // and which poisons the miter of both neighbouring joins.
    const last = points[points.length - 1];
    if (last && Math.abs(last.x - x) < 1e-6 && Math.abs(last.z - z) < 1e-6) continue;
    points.push({ x, z });
  }
  return points;
}

/** Per-vertex offset directions for a polyline: segment normals at the ends,
 * miters in between. */
function offsetNormals(points: Point2[]): Point2[] {
  const segments: Point2[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dz = points[i + 1].z - points[i].z;
    const length = Math.hypot(dx, dz);
    segments.push({ x: -dz / length, z: dx / length });
  }

  return points.map((_, i) => {
    if (i === 0) return segments[0];
    if (i === points.length - 1) return segments[segments.length - 1];

    const previous = segments[i - 1];
    const next = segments[i];
    const mx = previous.x + next.x;
    const mz = previous.z + next.z;
    const length = Math.hypot(mx, mz);
    if (length < 1e-6) return next; // exact reversal, nothing sensible to miter

    const nx = mx / length;
    const nz = mz / length;
    // 1/cos(half-angle) — how far the join has to extend to keep the ribbon
    // edges parallel through the corner.
    const scale = Math.min(1 / (nx * next.x + nz * next.z), MITER_LIMIT);
    return { x: nx * scale, z: nz * scale };
  });
}

function appendRibbon(
  points: Point2[],
  halfWidth: number,
  height: number,
  positions: number[],
  normals: number[],
  uvs: number[],
  indices: number[]
): void {
  if (points.length < 2) return;

  const offsets = offsetNormals(points);
  const base = positions.length / 3;
  let distance = 0;

  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      distance += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    }
    const offset = offsets[i];
    for (const side of [1, -1]) {
      positions.push(
        points[i].x + offset.x * halfWidth * side,
        height,
        points[i].z + offset.z * halfWidth * side
      );
      normals.push(0, 1, 0);
      // v runs in metres so a tiled texture keeps a constant real-world scale.
      uvs.push(side === 1 ? 0 : 1, distance);
    }
  }

  for (let i = 0; i < points.length - 1; i++) {
    const a = base + i * 2;
    // Winding matters, not just the `normal` attribute pushed above: the
    // vertex order below (a, a+2, a+1 / a+1, a+2, a+3) is what geometrically
    // faces up (verified by computing the cross product directly) — the
    // previous order wound these triangles face-down, so they were only
    // ever visible as a *back* face. `materials.ts`'s `path()` compensates
    // with `side: DoubleSide` as a safety net, but a back face's normal gets
    // flipped by three's shader for lighting purposes, which silently
    // discarded direct sun light and, at night, sampled the ambient
    // hemisphere light's dark "ground" color instead of its "sky" color —
    // paths rendered visible but went almost black after dusk. Correct
    // winding makes this the *front* face, so it's lit normally either way.
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

/** Paths arrive as LineStrings with a width, so they need to become ribbon
 * geometry. Everything sharing a surface material is merged into one mesh —
 * the baseline alone has ~200 path segments across 9 materials. On terrain,
 * the ribbons are laid on the ground (see shapes.ts's `drapeGeometry`). */
export function buildPaths(
  paths: DiscreteElement[],
  anchor: GeoAnchor,
  materials: MaterialLibrary,
  terrain: Terrain
): THREE.Group {
  const group = new THREE.Group();
  group.name = "paths";

  const byMaterial = new Map<
    string,
    { positions: number[]; normals: number[]; uvs: number[]; indices: number[] }
  >();

  for (const path of paths) {
    const material = String(path.properties.material ?? "paving");
    const width = Number(path.properties.width ?? DEFAULT_WIDTH_M);
    const isMarking = isPaintedPath(material);
    let buffers = byMaterial.get(material);
    if (!buffers) {
      buffers = { positions: [], normals: [], uvs: [], indices: [] };
      byMaterial.set(material, buffers);
    }
    for (const coords of lineStrings(path.geometry)) {
      appendRibbon(
        toLocalPoints(anchor, coords),
        Math.max(width, isMarking ? MIN_MARKING_WIDTH_M : MIN_PATH_WIDTH_M) / 2,
        ribbonHeight(material),
        buffers.positions,
        buffers.normals,
        buffers.uvs,
        buffers.indices
      );
    }
  }

  for (const [material, buffers] of byMaterial) {
    if (buffers.indices.length === 0) continue;
    let geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(buffers.positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(buffers.normals, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(buffers.uvs, 2));
    geometry.setIndex(buffers.indices);
    if (!terrain.flat) geometry = drapeGeometry(geometry, terrain, ribbonHeight(material));

    const mesh = new THREE.Mesh(geometry, materials.path(material));
    mesh.receiveShadow = true;
    mesh.name = `paths-${material}`;
    group.add(mesh);
  }

  return group;
}
