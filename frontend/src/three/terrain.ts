/** The ground's shape: its height anywhere in the local frame (see geo.ts),
 * for everything that stands on it, the camera and walk mode.
 *
 * A site without a terrain grid (see the backend's site_assets.py) is flat,
 * at y = 0 — `FLAT_TERRAIN` — and every builder then does exactly what it
 * did before terrain existed. With a grid, the ground is the grid's
 * triangles: each cell split along its (col, row)-(col + 1, row + 1)
 * diagonal, as the terrain surface draws it (builders/terrainSurface.ts).
 * `heightAt` is that same surface, not a smoother interpolation, so that
 * whatever is laid on the ground — covers, paths, cut along the same grid
 * lines by `drapeTriangles` — lies exactly on what's drawn, rather than
 * poking through it or floating over it on a convex fold.
 */

import type { TerrainGrid } from "../api/types";
import { toLocal, type GeoAnchor } from "./geo";

export interface Terrain {
  /** True for `FLAT_TERRAIN`: builders keep their flat geometry. */
  flat: boolean;
  heightAt: (x: number, z: number) => number;
  /** Unit normal, smoothed (for shading). */
  normalAt: (x: number, z: number) => [number, number, number];
  minHeight: number;
  maxHeight: number;
  /** The grid, in the local frame (shifted to this site's anchor). */
  grid: LocalGrid | null;
}

export interface LocalGrid {
  x0: number;
  z0: number;
  cols: number;
  rows: number;
  cellM: number;
  /** Row-major, metres above the lowest point. */
  heights: Float32Array;
}

const UP: [number, number, number] = [0, 1, 0];

export const FLAT_TERRAIN: Terrain = {
  flat: true,
  heightAt: () => 0,
  normalAt: () => UP,
  minHeight: 0,
  maxHeight: 0,
  grid: null,
};

/** Decodes a terrain grid (see the backend's `TerrainGrid`). The grid
 * carries the anchor it was built for; a different one (a site boundary
 * edited since) only shifts it. `scale` exaggerates the heights, for
 * testing on gentle ground (`?terrainScale=`). */
export function terrainFromGrid(response: TerrainGrid, anchor: GeoAnchor, scale = 1): Terrain {
  const bytes = Uint8Array.from(atob(response.heights), (c) => c.charCodeAt(0));
  const levels = new DataView(bytes.buffer);
  const heights = new Float32Array(response.cols * response.rows);
  let maxHeight = 0;
  for (let i = 0; i < heights.length; i++) {
    heights[i] = levels.getUint16(i * 2, true) * response.height_scale_m * scale;
    if (heights[i] > maxHeight) maxHeight = heights[i];
  }
  const [dx, dz] = toLocal(anchor, response.anchor_lng, response.anchor_lat);
  const grid: LocalGrid = {
    x0: response.x0 + dx,
    z0: response.z0 + dz,
    cols: response.cols,
    rows: response.rows,
    cellM: response.cell_m,
    heights,
  };
  const heightAt = gridHeight(grid);
  const d = grid.cellM;
  const normalAt = (x: number, z: number): [number, number, number] => {
    const nx = (heightAt(x - d, z) - heightAt(x + d, z)) / (2 * d);
    const nz = (heightAt(x, z - d) - heightAt(x, z + d)) / (2 * d);
    const length = Math.hypot(nx, 1, nz);
    return [nx / length, 1 / length, nz / length];
  };
  return { flat: false, heightAt, normalAt, minHeight: 0, maxHeight, grid };
}

/** The grid's triangulated surface; past its edge, the edge's height. */
function gridHeight(grid: LocalGrid): (x: number, z: number) => number {
  const { x0, z0, cols, rows, cellM, heights } = grid;
  return (x, z) => {
    const gx = Math.min(Math.max((x - x0) / cellM, 0), cols - 1);
    const gz = Math.min(Math.max((z - z0) / cellM, 0), rows - 1);
    const col = Math.min(Math.floor(gx), cols - 2);
    const row = Math.min(Math.floor(gz), rows - 2);
    const tx = gx - col;
    const tz = gz - row;
    const i = row * cols + col;
    const h00 = heights[i];
    const h11 = heights[i + cols + 1];
    // The two triangles either side of the cell's diagonal.
    return tx >= tz
      ? h00 + tx * (heights[i + 1] - h00) + tz * (h11 - heights[i + 1])
      : h00 + tz * (heights[i + cols] - h00) + tx * (h11 - heights[i + cols]);
  };
}

export interface RayHit {
  x: number;
  y: number;
  z: number;
  distance: number;
}

/** Where a ray from `origin` along `direction` (unit) first meets the
 * ground, within `maxDistance`; null if it doesn't. Marches in steps of a
 * grid cell, then bisects. */
export function intersectTerrain(
  terrain: Terrain,
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  maxDistance = 20000
): RayHit | null {
  const above = (s: number) =>
    origin.y + direction.y * s - terrain.heightAt(origin.x + direction.x * s, origin.z + direction.z * s);
  if (terrain.flat) {
    if (direction.y >= -1e-9 || origin.y <= 0) return null;
    const s = origin.y / -direction.y;
    return s <= maxDistance ? { x: origin.x + direction.x * s, y: 0, z: origin.z + direction.z * s, distance: s } : null;
  }
  if (above(0) <= 0) return null;
  const step = Math.max(terrain.grid!.cellM, 0.5);
  let lo = 0;
  for (let s = step; s <= maxDistance + step; s += step) {
    // Above the highest ground and going up: it never comes down again.
    if (direction.y >= 0 && origin.y + direction.y * s > terrain.maxHeight) return null;
    if (above(s) > 0) {
      lo = s;
      continue;
    }
    let hi = s;
    for (let i = 0; i < 30 && hi - lo > 1e-3; i++) {
      const mid = (lo + hi) / 2;
      if (above(mid) > 0) lo = mid;
      else hi = mid;
    }
    if (hi > maxDistance) return null;
    const x = origin.x + direction.x * hi;
    const z = origin.z + direction.z * hi;
    return { x, y: terrain.heightAt(x, z), z, distance: hi };
  }
  return null;
}

/** Lays flat triangles on the ground: each triangle (three vertices of
 * `stride` numbers, x and z first, then attributes interpolated with them —
 * a texture's u and v, say) is cut along the grid's lines and diagonals, so
 * every piece lies within one of the ground's triangles, and lifted onto it
 * by `lift` metres. Returns the pieces as vertices of x, y, z and the same
 * attributes. On flat ground, the triangles as they are, at y = lift. */
export function drapeTriangles(terrain: Terrain, triangles: number[], stride: number, lift: number): number[] {
  const out: number[] = [];
  const grid = terrain.grid;
  const emit = (vertex: number[]) => {
    out.push(vertex[0], terrain.heightAt(vertex[0], vertex[1]) + lift, vertex[1]);
    for (let k = 2; k < stride; k++) out.push(vertex[k]);
  };
  for (let t = 0; t + 3 * stride <= triangles.length; t += 3 * stride) {
    const polygon = [0, 1, 2].map((v) => triangles.slice(t + v * stride, t + (v + 1) * stride));
    if (!grid) {
      polygon.forEach(emit);
      continue;
    }
    // Three families of lines, in grid units: columns (gx = k), rows
    // (gz = k), and the cells' diagonals (gx - gz = k).
    const families: ((v: number[]) => number)[] = [
      (v) => (v[0] - grid.x0) / grid.cellM,
      (v) => (v[1] - grid.z0) / grid.cellM,
      (v) => (v[0] - grid.x0 - (v[1] - grid.z0)) / grid.cellM,
    ];
    let pieces = [polygon];
    for (const along of families) pieces = pieces.flatMap((piece) => splitByLines(piece, along));
    for (const piece of pieces) {
      // Convex: a fan.
      for (let i = 1; i + 1 < piece.length; i++) {
        emit(piece[0]);
        emit(piece[i]);
        emit(piece[i + 1]);
      }
    }
  }
  return out;
}

/** Cuts a convex polygon along the lines `along(v) = k`, for every integer
 * k it crosses. */
function splitByLines(polygon: number[][], along: (v: number[]) => number): number[][][] {
  const values = polygon.map(along);
  const lo = Math.floor(Math.min(...values));
  const hi = Math.ceil(Math.max(...values));
  if (hi - lo <= 1) return [polygon];
  const pieces: number[][][] = [];
  let rest = polygon;
  for (let k = lo + 1; k < hi; k++) {
    const [below, above] = cutAt(rest, along, k);
    if (below.length >= 3) pieces.push(below);
    rest = above;
    if (rest.length < 3) break;
  }
  if (rest.length >= 3) pieces.push(rest);
  return pieces;
}

/** A convex polygon's two sides of the line `along(v) = k`. */
function cutAt(polygon: number[][], along: (v: number[]) => number, k: number): [number[][], number[][]] {
  const below: number[][] = [];
  const above: number[][] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const da = along(a) - k;
    const db = along(b) - k;
    if (da <= 0) below.push(a);
    if (da >= 0) above.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const s = da / (da - db);
      const cut = a.map((value, j) => value + (b[j] - value) * s);
      below.push(cut);
      above.push(cut);
    }
  }
  return [below, above];
}

/** Points along a line on the ground, `lift` above it: extra points every
 * grid cell, so that the line follows the ground between its vertices. */
export function drapeLine(terrain: Terrain, points: [number, number][], lift: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const step = terrain.grid?.cellM ?? Infinity;
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i];
    if (i > 0 && !terrain.flat) {
      const [px, pz] = points[i - 1];
      const n = Math.ceil(Math.hypot(x - px, z - pz) / step);
      for (let j = 1; j < n; j++) {
        const sx = px + ((x - px) * j) / n;
        const sz = pz + ((z - pz) * j) / n;
        out.push([sx, terrain.heightAt(sx, sz) + lift, sz]);
      }
    }
    out.push([x, terrain.heightAt(x, z) + lift, z]);
  }
  return out;
}

/** The lowest and highest ground under a set of points. */
export function heightRange(terrain: Terrain, points: [number, number][]): [number, number] {
  if (terrain.flat || points.length === 0) return [0, 0];
  let min = Infinity;
  let max = -Infinity;
  for (const [x, z] of points) {
    const h = terrain.heightAt(x, z);
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return [min, max];
}
