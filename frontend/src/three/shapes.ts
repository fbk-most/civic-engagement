/** GeoJSON polygon -> THREE.Shape, in the local metric frame.
 *
 * A THREE.Shape is authored in 2D (u, v) and both ShapeGeometry and
 * ExtrudeGeometry emit it in the z=0 plane, so every consumer here follows the
 * same convention: build the shape with `u = localX, v = -localZ`, then
 * `rotateX(-PI/2)`. That maps a shape point to world (x, 0, z) the right way
 * round, and sends an extrusion's depth to +Y. Getting the sign wrong here
 * mirrors the whole site, which is surprisingly hard to notice on a square.
 */

import * as THREE from "three";
import { polygonRings, toLocal, type GeoAnchor } from "./geo";
import { drapeTriangles, heightRange, type Terrain } from "./terrain";

/** Height offsets that break ties between coplanar, overlapping cover
 * polygons. Every ground-level surface would otherwise land on the ground
 * itself (y = 0 on a flat site) and z-fight wherever two of them overlap.
 *
 * Overlap is not an edge case here: OSM tags the same ground twice all the
 * time (a park polygon and a garden polygon over each other, a pond inside a
 * lawn), and around Piazza Dante the baseline cover polygons sum to 54,745 m2
 * on a 41,019 m2 site. Covers are therefore lifted by their position in the
 * list, which resolves overlaps in favour of the later cover — matching the
 * precedence the space-use indicator already uses (`bologna_civic_dt/geometry.py`), so the
 * surface you see is the one the percentages counted.
 *
 * This band only needs to be large enough to force a real depth ordering
 * between two identically-offset materials (see `materials.ts`'s `cover()`,
 * which already applies `polygonOffset` — the actual, distance-independent
 * z-fighting fix; this Y-lift is only the tie-breaker on top of it). It does
 * *not* model a real elevation difference between e.g. lawn and pavement.
 * At the old 0.06 (6cm), it accidentally did: every discrete element (bench,
 * streetlight, tree — see `builders/vegetation.ts`/`streetlights.ts`) is
 * placed at a flat y=0 regardless of which cover polygon is under it, so
 * whichever cover happened to land last in the list (in the Piazza Dante
 * baseline, the catch-all "leftover paving" that most furniture actually
 * stands on) rendered up to 6cm *above* everything assumed to be at ground
 * level — read as benches/streetlights floating over the lawn, by roughly
 * the amount reported. Shrunk to the minimum that still reliably wins a
 * depth tie.
 */
export const COVER_BAND_M = 0.01;
// Must stay above the cover band's top so a path still renders over a lawn
// polygon it crosses. This was briefly widened to 0.16 (a mis-diagnosed
// z-fighting fix; the real "paths invisible" bug was reversed triangle
// winding in paths.ts) and read as a 10cm curb, then cut all the way down to
// 0.018 total — too close: at real viewing distance a perspective camera's
// depth precision is coarse enough that an 8mm gap still visibly z-fights
// (flickers between path and cover depending on angle/distance). The actual
// distance-independent fix is `polygonOffset` on both materials (see
// `materials.ts`'s `path()` and `cover()`), same technique already used
// between overlapping covers; this margin just needs to be comfortably
// outside the z-fighting-prone range, not do that job by itself.
export const PATH_HEIGHT_M = COVER_BAND_M + 0.03;

/** Height for the `index`-th of `total` cover polygons. Spread across a fixed
 * band rather than a fixed step per cover, so the stack stays below the paths
 * no matter how many ground-cover interventions get placed. */
export function coverHeight(index: number, total: number): number {
  return total <= 1 ? 0 : (index / (total - 1)) * COVER_BAND_M;
}

function signedArea(points: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return area / 2;
}

function ringToPoints(anchor: GeoAnchor, ring: GeoJSON.Position[]): THREE.Vector2[] {
  const points: THREE.Vector2[] = [];
  for (const [lng, lat] of ring) {
    const [x, z] = toLocal(anchor, lng, lat);
    points.push(new THREE.Vector2(x, -z));
  }
  // GeoJSON closes its rings; THREE.Shape re-closes implicitly and a duplicate
  // final vertex produces a degenerate triangle.
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 1 && first.x === last.x && first.y === last.y) points.pop();
  return points;
}

/** Outer ring of each polygon (a MultiPolygon yields several) as world (x, z)
 * pairs — packed into `Vector2(x, z)` rather than the shape-space (u, v) the
 * rest of this file uses, since roof-massing code (see `builders/roofs.ts`)
 * works directly in the ground plane and would otherwise have to un-flip the
 * `v = -z` convention `ringToPoints` uses for `THREE.Shape`. Holes are
 * dropped: no building in this baseline has an interior courtyard ring, and
 * roof massing over one would need real polygon-with-holes support anyway. */
export function outerRingsXZ(anchor: GeoAnchor, geometry: GeoJSON.Geometry): THREE.Vector2[][] {
  const rings: THREE.Vector2[][] = [];
  for (const polygonRing of polygonRings(geometry)) {
    const points: THREE.Vector2[] = [];
    for (const [lng, lat] of polygonRing[0]) {
      const [x, z] = toLocal(anchor, lng, lat);
      points.push(new THREE.Vector2(x, z));
    }
    const first = points[0];
    const last = points[points.length - 1];
    if (points.length > 1 && first.x === last.x && first.y === last.y) points.pop();
    if (points.length >= 3) rings.push(points);
  }
  return rings;
}

/** One THREE.Shape per polygon (a MultiPolygon yields several), holes included. */
export function geometryToShapes(anchor: GeoAnchor, geometry: GeoJSON.Geometry): THREE.Shape[] {
  const shapes: THREE.Shape[] = [];
  for (const rings of polygonRings(geometry)) {
    const outer = ringToPoints(anchor, rings[0]);
    if (outer.length < 3) continue;
    // Outer ring counter-clockwise, holes clockwise: the triangulator tolerates
    // either, but consistent winding keeps the generated face normals pointing
    // up so the ground lights correctly under a single-sided material.
    if (signedArea(outer) < 0) outer.reverse();

    const shape = new THREE.Shape(outer);
    for (const ring of rings.slice(1)) {
      const hole = ringToPoints(anchor, ring);
      if (hole.length < 3) continue;
      if (signedArea(hole) > 0) hole.reverse();
      shape.holes.push(new THREE.Path(hole));
    }
    shapes.push(shape);
  }
  return shapes;
}

/** Flat horizontal mesh geometry for a polygon, at height `y`. */
export function flatGeometry(
  anchor: GeoAnchor,
  geometry: GeoJSON.Geometry,
  y: number
): THREE.BufferGeometry | null {
  const shapes = geometryToShapes(anchor, geometry);
  if (shapes.length === 0) return null;
  const geom = new THREE.ShapeGeometry(shapes);
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, y, 0);
  return geom;
}

/** Flat geometry in the XZ plane (positions, and uvs if it has them) laid
 * on the ground, `lift` above it: cut along the ground's grid so that it
 * lies exactly on it (see terrain.ts's `drapeTriangles`), shaded by the
 * ground's own normals. Disposes `flat`. */
export function drapeGeometry(flat: THREE.BufferGeometry, terrain: Terrain, lift: number): THREE.BufferGeometry {
  const position = flat.getAttribute("position");
  const uv = flat.getAttribute("uv") as THREE.BufferAttribute | undefined;
  const stride = uv ? 4 : 2;
  const triangles: number[] = [];
  const count = flat.index ? flat.index.count : position.count;
  for (let k = 0; k < count; k++) {
    const i = flat.index ? flat.index.getX(k) : k;
    triangles.push(position.getX(i), position.getZ(i));
    if (uv) triangles.push(uv.getX(i), uv.getY(i));
  }
  flat.dispose();

  const draped = drapeTriangles(terrain, triangles, stride, lift);
  const vertices = draped.length / (stride + 1);
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const uvs = uv ? new Float32Array(vertices * 2) : null;
  for (let v = 0; v < vertices; v++) {
    const at = v * (stride + 1);
    positions.set([draped[at], draped[at + 1], draped[at + 2]], v * 3);
    normals.set(terrain.normalAt(draped[at], draped[at + 2]), v * 3);
    if (uvs) uvs.set([draped[at + 3], draped[at + 4]], v * 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  if (uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  return geometry;
}

/** The lowest and highest ground along a polygon's outline. */
export function outlineHeightRange(terrain: Terrain, anchor: GeoAnchor, geometry: GeoJSON.Geometry): [number, number] {
  if (terrain.flat) return [0, 0];
  return heightRange(terrain, outerRingsXZ(anchor, geometry).flatMap((ring) => ring.map((p) => [p.x, p.y] as [number, number])));
}
