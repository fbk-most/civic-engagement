/** A forest's trees, as many as a valley's stands hold: not one by one, as
 * the scene's elements are (see vegetation.ts), but from the pack's tree
 * source (`FrontendPack.scene3d.treeSource`), which grows them from the
 * covers — the rural pack's stands, say.
 *
 * Each tree is a trunk and a crown — a cone or a rounded crown — drawn as
 * instances. A tree kind's crowns share one colour, which the season
 * changes (`applySeason`): nothing is rebuilt, as for the scene's own
 * trees. Each tree's own shade of it is the instance's colour.
 *
 * The forest is cut into square tiles, each with its own meshes, so that
 * the renderer leaves out the tiles out of view, and so that only the tiles
 * near the camera cast shadows: further away, a tree's shadow is a pixel or
 * two, for the cost of drawing the tree again.
 *
 * For testing (`?treeFar=`), the tiles beyond a distance can be drawn
 * thinned out: only the trees whose `rank` is under FAR_SHARE — always the
 * same ones, so coming closer only adds trees — with wider crowns to make up
 * for the missing ones, and no trunks. It showed too much (the overview,
 * the slopes across the valley), so it's off by default.
 */

import * as THREE from "three";
import type { CoverPolygon, DiscreteElement } from "../../api/types";
import type { GeoAnchor } from "../geo";
import type { MaterialLibrary } from "../materials";
import type { ScenePart } from "../parts";
import type { SeasonState } from "../sun";
import type { Terrain } from "../terrain";
import { readDebugParams } from "../../debugParams";

export interface ForestTree {
  /** In the local frame; the tree stands on the ground there. */
  x: number;
  z: number;
  height: number;
  crownDiameter: number;
  /** Where the crown starts, as a share of the height. */
  crownBase: number;
  /** A key of the source's `kinds`. */
  kind: string;
  /** The tree's own shade of its kind's colour, around 1. */
  shade: number;
  /** A draw in [0, 1), the same on every build: from afar, only the trees
   * with the lowest ranks are drawn. */
  rank: number;
}

export interface TreeKind {
  crown: "cone" | "round";
  /** The crown's colours (sRGB): in leaf, in full autumn colour and bare.
   * A kind without the last two is evergreen. */
  summer: number;
  autumn?: number;
  bare?: number;
}

export interface TreeSource {
  kinds: Record<string, TreeKind>;
  /** The trees of the covers; the elements (roads, buildings...) say where
   * none should stand. */
  trees: (inputs: { covers: CoverPolygon[]; elements: DiscreteElement[]; anchor: GeoAnchor; terrain: Terrain }) => ForestTree[];
}

export interface Forest {
  part: ScenePart;
  applySeason: (season: SeasonState) => void;
}

const TRUNK_RADIUS_SHARE = 0.018;
const MIN_TRUNK_RADIUS_M = 0.05;

const TILE_M = 192;
// Distances from the camera to a tile's box: within SHADOW_M its trees
// cast shadows; beyond MID_MAX_M it's thinned out (testing only, see
// above). HYSTERESIS keeps a tile on a border from switching back and forth.
const DEBUG = readDebugParams();
const SHADOW_M = DEBUG.treeShadows === "off" ? -Infinity : (DEBUG.treeShadows ?? 1200);
const MID_MAX_M = typeof DEBUG.treeFar === "number" ? DEBUG.treeFar : Infinity;
const HYSTERESIS = 0.15;
const FAR_SHARE = 0.1;
const FAR_WIDENING = FAR_SHARE ** -0.2;
// The camera moves this much before the tiles' levels are checked again.
const RECHECK_M = 5;

// Low: there are hundreds of thousands of them.
const trunkGeometry = new THREE.CylinderGeometry(0.8, 1, 1, 4, 1, true).translate(0, 0.5, 0);
const crownGeometries = {
  cone: new THREE.ConeGeometry(0.5, 1, 7).translate(0, 0.5, 0),
  round: new THREE.IcosahedronGeometry(0.5, 0).translate(0, 0.5, 0),
};

type Level = "mid" | "far";

interface Tile {
  box: THREE.Box3;
  mid: THREE.Group;
  far: THREE.Group | null;
  level: Level;
  /** The meshes that cast shadows when the tile is near. */
  casters: THREE.InstancedMesh[];
  shadows: boolean;
}

/** A tile's state at `distance` from the camera, given its current one:
 * past `limit` by HYSTERESIS to change. */
function within(limit: number, distance: number, now: boolean): boolean {
  return now ? distance <= limit * (1 + HYSTERESIS) : distance < limit * (1 - HYSTERESIS);
}

export function buildForest(
  source: TreeSource,
  covers: CoverPolygon[],
  elements: DiscreteElement[],
  anchor: GeoAnchor,
  materials: MaterialLibrary,
  terrain: Terrain
): Forest {
  const trees = source.trees({ covers, elements, anchor, terrain });
  const group = new THREE.Group();
  group.name = "forest";

  const crownMaterials = new Map<string, THREE.MeshStandardMaterial>();
  for (const [name, kind] of Object.entries(source.kinds)) {
    crownMaterials.set(name, materials.shared(`forest-crown:${name}`, { color: kind.summer, roughness: 0.95 }));
  }

  const byTile = new Map<string, ForestTree[]>();
  for (const tree of trees) {
    const key = `${Math.floor(tree.x / TILE_M)},${Math.floor(tree.z / TILE_M)}`;
    let list = byTile.get(key);
    if (!list) byTile.set(key, (list = []));
    list.push(tree);
  }

  const meshes: THREE.InstancedMesh[] = [];
  const tiles: Tile[] = [];
  const matrix = new THREE.Matrix4();
  const shade = new THREE.Color();
  for (const list of byTile.values()) {
    const grounds = list.map((tree) => terrain.heightAt(tree.x, tree.z));
    const box = new THREE.Box3();
    list.forEach((tree, i) => {
      box.expandByPoint(new THREE.Vector3(tree.x, grounds[i], tree.z));
      box.expandByPoint(new THREE.Vector3(tree.x, grounds[i] + tree.height, tree.z));
    });

    const add = (target: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, count: number, name: string) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      // See `frame`.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = name;
      // The geometries are this module's, for every scene: `disposeGroup`
      // leaves them alone.
      mesh.userData.sharedGeometry = true;
      meshes.push(mesh);
      target.add(mesh);
      return mesh;
    };
    const crowns = (target: THREE.Group, indices: number[], widening: number) => {
      for (const [name, kind] of Object.entries(source.kinds)) {
        const ofKind = indices.filter((i) => list[i].kind === name);
        if (ofKind.length === 0) continue;
        const mesh = add(target, crownGeometries[kind.crown], crownMaterials.get(name)!, ofKind.length, `forest-crowns-${name}`);
        ofKind.forEach((index, i) => {
          const tree = list[index];
          const base = tree.height * tree.crownBase;
          const width = tree.crownDiameter * widening;
          mesh.setMatrixAt(i, matrix.makeScale(width, tree.height - base, width).setPosition(tree.x, grounds[index] + base, tree.z));
          mesh.setColorAt(i, shade.setScalar(tree.shade));
        });
        mesh.computeBoundingSphere();
      }
    };

    const mid = new THREE.Group();
    mid.name = "forest-mid";
    const trunks = add(mid, trunkGeometry, materials.bark(), list.length, "forest-trunks");
    list.forEach((tree, i) => {
      const radius = Math.max(tree.height * TRUNK_RADIUS_SHARE, MIN_TRUNK_RADIUS_M);
      // Into the crown, so that no gap shows between them.
      trunks.setMatrixAt(i, matrix.makeScale(radius, tree.height * (tree.crownBase + 0.1), radius).setPosition(tree.x, grounds[i], tree.z));
    });
    trunks.computeBoundingSphere();
    const all = list.map((_, i) => i);
    crowns(mid, all, 1);

    const casters = mid.children as THREE.InstancedMesh[];
    group.add(mid);
    let far: THREE.Group | null = null;
    if (MID_MAX_M < Infinity) {
      far = new THREE.Group();
      far.name = "forest-far";
      crowns(far, all.filter((i) => list[i].rank < FAR_SHARE), FAR_WIDENING);
      // Far until the camera is known (see `frame`).
      mid.visible = false;
      group.add(far);
    }
    tiles.push({ box, mid, far, level: far ? "far" : "mid", casters: [...casters], shadows: false });
  }

  const checkedAt = new THREE.Vector3(Infinity, Infinity, Infinity);
  const frame = (camera: THREE.Camera) => {
    if (camera.position.distanceTo(checkedAt) < RECHECK_M) return;
    checkedAt.copy(camera.position);
    for (const tile of tiles) {
      const distance = tile.box.distanceToPoint(camera.position);
      const shadows = within(SHADOW_M, distance, tile.shadows);
      if (shadows !== tile.shadows) {
        tile.shadows = shadows;
        for (const mesh of tile.casters) mesh.castShadow = shadows;
      }
      if (!tile.far) continue;
      const level: Level = within(MID_MAX_M, distance, tile.level === "mid") ? "mid" : "far";
      if (level === tile.level) continue;
      tile.level = level;
      tile.mid.visible = level === "mid";
      tile.far.visible = level === "far";
    }
  };

  const seasonal = Object.entries(source.kinds).filter(([, kind]) => kind.autumn !== undefined && kind.bare !== undefined);
  const summer = new THREE.Color();
  const autumn = new THREE.Color();
  const bare = new THREE.Color();
  const applySeason = (season: SeasonState) => {
    for (const [name, kind] of seasonal) {
      summer.setHex(kind.summer);
      autumn.setHex(kind.autumn!);
      bare.setHex(kind.bare!);
      const leaves = Math.max(0, Math.min(1, season.leafDensity));
      crownMaterials.get(name)!.color.copy(summer).lerp(autumn, season.autumnMix).lerp(bare, 1 - leaves);
    }
  };

  return {
    part: {
      object: group,
      frame,
      // The instances' buffers.
      dispose: () => meshes.forEach((mesh) => mesh.dispose()),
    },
    applySeason,
  };
}
