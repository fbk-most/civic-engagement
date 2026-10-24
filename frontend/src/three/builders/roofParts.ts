/** An L-, T- or U-shaped footprint as rectangles, each to get a pitched roof
 * of its own (see roofs.ts): the roofs of a house's wings, all of one pitch
 * from one eave height, crossing where the wings meet. Drawn crossing, the
 * meshes show what a real cross-gabled roof shows — the valley where two
 * slopes meet — so no roof needs cutting.
 *
 * Works in the footprint's own frame (its minimum oriented box: x across,
 * z along), where a house's walls run along the axes, give or take the
 * survey's wobble.
 */

import * as THREE from "three";

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Corners closer than this, along x or along z, are one: a footprint's
 * small jogs and its survey's wobble squared off. */
const SNAP_M = 1.2;
/** Squared off, the footprint must keep its area to within this. */
const AREA_TOLERANCE = 0.1;
/** At most this many rectangles: more, and the footprint isn't a house's
 * wings (a compound, a curved building): it keeps its flat roof. */
const MAX_PARTS = 5;
/** What the rectangles may leave uncovered, in m², before growing over it
 * (see `footprintRects`): slivers, hidden by the eaves. Anything larger gets
 * a rectangle of its own: the building's flat top would show. */
const LEFTOVER_M2 = 3;

const EPS = 1e-6;

/** Values within `SNAP_M` of each other, as one: their mean (the first of
 * a group and the last no further apart, so that a group doesn't creep
 * along a staircase of jogs). */
function snapper(values: number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && v - last[0] < SNAP_M) last.push(v);
    else clusters.push([v]);
  }
  const means = clusters.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
  return (v) => means[clusters.findIndex((c) => v >= c[0] - EPS && v <= c[c.length - 1] + EPS)];
}

function area(points: [number, number][]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(sum) / 2;
}

function inside(points: [number, number][], x: number, z: number): boolean {
  let odd = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i];
    const [xj, zj] = points[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) odd = !odd;
  }
  return odd;
}

/** The footprint `ring` (world x, z) as rectangles in the frame of `angle`
 * and `center` (see roofs.ts's `placeInWorld`), or null if it isn't made of
 * a few: the walls' (the footprint squared off: the walls stand under the
 * roofs, rather than poke through their eaves where the footprint strays
 * from its rectangles), and the roofs' (the same, the wings running on into
 * the blocks they meet: see `reachingRidges`). */
export function footprintRects(
  ring: THREE.Vector2[],
  angle: number,
  center: THREE.Vector2
): { walls: Rect[]; roofs: Rect[] } | null {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const local: [number, number][] = ring.map((p) => {
    const dx = p.x - center.x;
    const dz = p.y - center.y;
    return [cos * dx + sin * dz, -sin * dx + cos * dz];
  });

  // Squared off: every corner on the grid of the walls' lines.
  const snapX = snapper(local.map(([x]) => x));
  const snapZ = snapper(local.map(([, z]) => z));
  const snapped: [number, number][] = [];
  for (const [x, z] of local) {
    const p: [number, number] = [snapX(x), snapZ(z)];
    const last = snapped[snapped.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) snapped.push(p);
  }
  while (snapped.length > 1 && snapped[0][0] === snapped[snapped.length - 1][0] && snapped[0][1] === snapped[snapped.length - 1][1]) {
    snapped.pop();
  }
  if (snapped.length < 4) return null;
  // Walls along the axes only: a slanting one is no wing's.
  for (let i = 0; i < snapped.length; i++) {
    const [ax, az] = snapped[i];
    const [bx, bz] = snapped[(i + 1) % snapped.length];
    if (ax !== bx && az !== bz) return null;
  }
  const total = area(snapped);
  if (Math.abs(total - area(local)) > AREA_TOLERANCE * area(local)) return null;

  // The grid's cells, those inside.
  const xs = [...new Set(snapped.map(([x]) => x))].sort((a, b) => a - b);
  const zs = [...new Set(snapped.map(([, z]) => z))].sort((a, b) => a - b);
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  const filled = Array.from({ length: nx }, (_, i) =>
    Array.from({ length: nz }, (_, j) => inside(snapped, (xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2))
  );
  const covered = Array.from({ length: nx }, () => new Array<boolean>(nz).fill(false));

  // The largest rectangles of cells not yet covered, largest first.
  const cells = (r: Cells) => {
    const out: [number, number][] = [];
    for (let i = r.i0; i <= r.i1; i++) for (let j = r.j0; j <= r.j1; j++) out.push([i, j]);
    return out;
  };
  const cellArea = ([i, j]: [number, number]) => (xs[i + 1] - xs[i]) * (zs[j + 1] - zs[j]);
  const allFilled = (r: Cells) => cells(r).every(([i, j]) => filled[i][j]);
  const free = (r: Cells) => cells(r).every(([i, j]) => filled[i][j] && !covered[i][j]);
  const cover = (r: Cells) => {
    let gained = 0;
    for (const [i, j] of cells(r)) {
      if (!covered[i][j]) gained += cellArea([i, j]);
      covered[i][j] = true;
    }
    return gained;
  };
  const parts: Cells[] = [];
  let left = total;
  while (left > LEFTOVER_M2) {
    if (parts.length === MAX_PARTS) return null;
    let best: (Cells & { area: number }) | null = null;
    for (let i0 = 0; i0 < nx; i0++) {
      for (let j0 = 0; j0 < nz; j0++) {
        for (let i1 = i0; i1 < nx; i1++) {
          if (!free({ i0, i1, j0, j1: j0 })) break;
          for (let j1 = j0; j1 < nz; j1++) {
            if (!free({ i0, i1, j0: j1, j1 })) break;
            const a = (xs[i1 + 1] - xs[i0]) * (zs[j1 + 1] - zs[j0]);
            if (!best || a > best.area) best = { i0, i1, j0, j1, area: a };
          }
        }
      }
    }
    if (!best) break;
    parts.push(best);
    left -= cover(best);
  }

  // What's left, the rectangles grow over where they can (over each other
  // too): a strip left without a roof would show the building's flat top.
  for (let grown = true; grown; ) {
    grown = false;
    for (const r of parts) {
      for (const side of [
        { ...r, i0: r.i0 - 1, i1: r.i0 - 1 },
        { ...r, i0: r.i1 + 1, i1: r.i1 + 1 },
        { ...r, j0: r.j0 - 1, j1: r.j0 - 1 },
        { ...r, j0: r.j1 + 1, j1: r.j1 + 1 },
      ]) {
        if (side.i0 < 0 || side.i1 >= nx || side.j0 < 0 || side.j1 >= nz) continue;
        if (!allFilled(side) || cells(side).every(([i, j]) => covered[i][j])) continue;
        cover(side);
        r.i0 = Math.min(r.i0, side.i0);
        r.i1 = Math.max(r.i1, side.i1);
        r.j0 = Math.min(r.j0, side.j0);
        r.j1 = Math.max(r.j1, side.j1);
        grown = true;
      }
    }
  }

  const walls = parts.map((r) => ({ x0: xs[r.i0], x1: xs[r.i1 + 1], z0: zs[r.j0], z1: zs[r.j1 + 1] }));
  return { walls, roofs: reachingRidges(walls) };
}

/** A rectangle of the grid's cells, by index, inclusive. */
interface Cells {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

const width = (r: Rect) => Math.min(r.x1 - r.x0, r.z1 - r.z0);
const alongX = (r: Rect) => r.x1 - r.x0 >= r.z1 - r.z0;

/** A wing ending against a wider block, across the block's ridge, runs on
 * into the block up to its ridge: its roof then meets the block's roof in a
 * valley, rather than ending in a gable against the block's side. */
function reachingRidges(rects: Rect[]): Rect[] {
  return rects.map((wing) => {
    const out = { ...wing };
    for (const block of rects) {
      if (block === wing || width(block) <= width(wing)) continue;
      const reach = width(block) / 2;
      if (alongX(wing) && !alongX(block) && wing.z0 >= block.z0 - EPS && wing.z1 <= block.z1 + EPS) {
        if (Math.abs(wing.x1 - block.x0) < EPS) out.x1 = wing.x1 + reach;
        if (Math.abs(wing.x0 - block.x1) < EPS) out.x0 = wing.x0 - reach;
      }
      if (!alongX(wing) && alongX(block) && wing.x0 >= block.x0 - EPS && wing.x1 <= block.x1 + EPS) {
        if (Math.abs(wing.z1 - block.z0) < EPS) out.z1 = wing.z1 + reach;
        if (Math.abs(wing.z0 - block.z1) < EPS) out.z0 = wing.z0 - reach;
      }
    }
    return out;
  });
}
