import { polygonRings, toLocal, type ForestTree, type TreeSource } from "civic-engagement";

// The stands' trees (see the backend's stands.py), grown in the browser.
//
// They come from one fixed pattern over the whole site — a lattice, each
// point jittered by its own seeded draws — and a point is a tree where a
// stand is, if its draw is under the stand's density. A tree's place, kind
// and size don't depend on the stand's shape, then: a felling takes the
// trees in its area away and moves no other.
//
// Only a share of the trees is drawn (`?treeShare=`, default 0.1): the
// stands hold about 340,000, too many to draw one by one until the trees
// have detail levels. The crowns are a little wider to make up for it.

// The densest stand there is: a planting (stands.py's PLANTING_DENSITY_PER_HA).
const MAX_DENSITY_PER_HA = 2000;
const LATTICE_M = Math.sqrt(10_000 / MAX_DENSITY_PER_HA);

const DEFAULT_SHARE = 0.1;
const SHARE = (() => {
  const value = Number(new URLSearchParams(window.location.search).get("treeShare"));
  return value > 0 && value <= 1 ? value : DEFAULT_SHARE;
})();
const CROWN_WIDENING = SHARE ** -0.2;

// A grown tree of each species: its height, its crown's width and where the
// crown starts, as shares of the height. Placeholders, as the stands are.
const SPECIES: Record<string, { height: number; crown: number; crownBase: number }> = {
  spruce: { height: 28, crown: 0.22, crownBase: 0.12 },
  larch: { height: 26, crown: 0.26, crownBase: 0.35 },
  beech: { height: 24, crown: 0.38, crownBase: 0.4 },
};
// How fast a planting grows: share of the grown height, by age.
const GROWTH_YEARS = 35;
const MIN_HEIGHT_M = 0.4;

export const standTrees: TreeSource = {
  kinds: {
    spruce: { crown: "cone", summer: 0x2b4a2c },
    larch: { crown: "cone", summer: 0x5d8238, autumn: 0xc79a35, bare: 0x7b6b58 },
    beech: { crown: "round", summer: 0x4c7a2c, autumn: 0x9c5a26, bare: 0x6f6152 },
  },
  trees: ({ covers, anchor }) => {
    const trees: ForestTree[] = [];
    for (const cover of covers) {
      if (cover.cover_type !== "forest" && cover.cover_type !== "planting") continue;
      const density = Number(cover.properties.density_per_ha ?? 0);
      const mix = (cover.properties.species_mix ?? {}) as Record<string, number>;
      const age = cover.cover_type === "planting" ? Number(cover.properties.age_years ?? 0) : null;
      const grown = age === null ? 1 : (1 - Math.exp(-age / GROWTH_YEARS)) ** 1.3;
      const keep = (density / MAX_DENSITY_PER_HA) * SHARE;
      for (const rings of polygonRings(cover.geometry)) {
        const local = rings.map((ring) => ring.map(([lng, lat]) => toLocal(anchor, lng, lat)));
        latticeIn(local, keep, (i, j, x, z) => {
          const kind = pick(mix, draw(i, j, 3));
          const species = SPECIES[kind];
          if (!species) return;
          const height = species.height * grown * (0.8 + 0.4 * draw(i, j, 4));
          if (height < MIN_HEIGHT_M) return;
          trees.push({
            x,
            z,
            height,
            crownDiameter: height * species.crown * CROWN_WIDENING,
            crownBase: species.crownBase,
            kind,
            shade: 0.82 + 0.36 * draw(i, j, 5),
          });
        });
      }
    }
    return trees;
  },
};

/** Calls `visit` for every lattice point inside the polygon (`rings`, the
 * first the outer one) whose first draw is under `keep`, with its lattice
 * indices and its place, jittered. A
 * point is tested against the edges of its own row only: they're sorted
 * into rows first. The jitter keeps a point within its cell, so its row is
 * known before it's drawn. */
function latticeIn(rings: [number, number][][], keep: number, visit: (i: number, j: number, x: number, z: number) => void): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of rings.flat()) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const i0 = Math.floor(minX / LATTICE_M);
  const i1 = Math.ceil(maxX / LATTICE_M);
  const j0 = Math.floor(minZ / LATTICE_M);
  const j1 = Math.ceil(maxZ / LATTICE_M);
  const rows: [number, number, number, number][][] = Array.from({ length: j1 - j0 + 1 }, () => []);
  for (const ring of rings) {
    for (let k = 0; k < ring.length; k++) {
      const [ax, az] = ring[k];
      const [bx, bz] = ring[(k + 1) % ring.length];
      if (az === bz) continue;
      const from = Math.max(j0, Math.floor(Math.min(az, bz) / LATTICE_M));
      const to = Math.min(j1, Math.floor(Math.max(az, bz) / LATTICE_M));
      for (let j = from; j <= to; j++) rows[j - j0].push([ax, az, bx, bz]);
    }
  }
  for (let j = j0; j <= j1; j++) {
    const edges = rows[j - j0];
    if (edges.length === 0) continue;
    for (let i = i0; i <= i1; i++) {
      if (draw(i, j, 0) >= keep) continue;
      const x = (i + draw(i, j, 1)) * LATTICE_M;
      const z = (j + draw(i, j, 2)) * LATTICE_M;
      // Even-odd: holes are rings too.
      let inside = false;
      for (const [ax, az, bx, bz] of edges) {
        if (az > z !== bz > z && x < ax + ((z - az) * (bx - ax)) / (bz - az)) inside = !inside;
      }
      if (inside) visit(i, j, x, z);
    }
  }
}

/** The lattice point (i, j)'s draw number `k`, in [0, 1): the same on every
 * build. */
function draw(i: number, j: number, k: number): number {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k + 1, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2 ** 32;
}

/** The species a draw `u` falls on, by the mix's shares. */
function pick(mix: Record<string, number>, u: number): string {
  const entries = Object.entries(mix);
  const total = entries.reduce((sum, [, share]) => sum + share, 0);
  let below = 0;
  for (const [species, share] of entries) {
    below += share / total;
    if (u < below) return species;
  }
  return entries[entries.length - 1]?.[0] ?? "";
}
