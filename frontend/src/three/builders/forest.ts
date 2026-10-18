/** A forest's trees, as many as a valley's stands hold: not one by one, as
 * the scene's elements are (see vegetation.ts), but from the pack's tree
 * source (`FrontendPack.scene3d.treeSource`), which grows them from the
 * covers — the rural pack's stands, say.
 *
 * Each tree is a trunk and a crown — a cone or a rounded crown — drawn as
 * instances, a few draw calls for the whole forest. A tree kind's crowns
 * share one colour, which the season changes (`applySeason`): nothing is
 * rebuilt, as for the scene's own trees. Each tree's own shade of it is the
 * instance's colour.
 *
 * A first, plain version: no detail levels and no tiles yet, every tree
 * drawn, the same way, wherever the camera is.
 */

import * as THREE from "three";
import type { CoverPolygon } from "../../api/types";
import type { GeoAnchor } from "../geo";
import type { MaterialLibrary } from "../materials";
import type { ScenePart } from "../parts";
import type { SeasonState } from "../sun";
import type { Terrain } from "../terrain";

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
  trees: (inputs: { covers: CoverPolygon[]; anchor: GeoAnchor; terrain: Terrain }) => ForestTree[];
}

export interface Forest {
  part: ScenePart;
  applySeason: (season: SeasonState) => void;
}

const TRUNK_RADIUS_SHARE = 0.018;
const MIN_TRUNK_RADIUS_M = 0.05;

// Low: there are tens of thousands of them, seen mostly from afar.
const trunkGeometry = new THREE.CylinderGeometry(0.8, 1, 1, 4, 1, true).translate(0, 0.5, 0);
const crownGeometries = {
  cone: new THREE.ConeGeometry(0.5, 1, 7).translate(0, 0.5, 0),
  round: new THREE.IcosahedronGeometry(0.5, 0).translate(0, 0.5, 0),
};

export function buildForest(
  source: TreeSource,
  covers: CoverPolygon[],
  anchor: GeoAnchor,
  materials: MaterialLibrary,
  terrain: Terrain
): Forest {
  const trees = source.trees({ covers, anchor, terrain });
  const group = new THREE.Group();
  group.name = "forest";

  const matrix = new THREE.Matrix4();
  const shade = new THREE.Color();
  const meshes: THREE.InstancedMesh[] = [];
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, count: number, name: string) => {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    // See instancing.ts: the source geometry's bounds aren't the forest's.
    mesh.frustumCulled = false;
    // The geometries are this module's, for every scene: `disposeGroup`
    // leaves them alone.
    mesh.userData.sharedGeometry = true;
    meshes.push(mesh);
    group.add(mesh);
    return mesh;
  };

  if (trees.length > 0) {
    const trunks = add(trunkGeometry, materials.bark(), trees.length, "forest-trunks");
    trees.forEach((tree, i) => {
      const y = terrain.heightAt(tree.x, tree.z);
      const radius = Math.max(tree.height * TRUNK_RADIUS_SHARE, MIN_TRUNK_RADIUS_M);
      // Into the crown, so that no gap shows between them.
      trunks.setMatrixAt(i, matrix.makeScale(radius, tree.height * (tree.crownBase + 0.1), radius).setPosition(tree.x, y, tree.z));
    });
  }

  // The crowns, one mesh per kind, its material's colour following the season.
  const seasonal: { material: THREE.MeshStandardMaterial; kind: TreeKind }[] = [];
  for (const [name, kind] of Object.entries(source.kinds)) {
    const ofKind = trees.filter((tree) => tree.kind === name);
    if (ofKind.length === 0) continue;
    const material = materials.shared(`forest-crown:${name}`, { color: kind.summer, roughness: 0.95 });
    const crowns = add(crownGeometries[kind.crown], material, ofKind.length, `forest-crowns-${name}`);
    ofKind.forEach((tree, i) => {
      const y = terrain.heightAt(tree.x, tree.z);
      const base = tree.height * tree.crownBase;
      crowns.setMatrixAt(
        i,
        matrix.makeScale(tree.crownDiameter, tree.height - base, tree.crownDiameter).setPosition(tree.x, y + base, tree.z)
      );
      crowns.setColorAt(i, shade.setScalar(tree.shade));
    });
    if (kind.autumn !== undefined && kind.bare !== undefined) seasonal.push({ material, kind });
  }

  const summer = new THREE.Color();
  const autumn = new THREE.Color();
  const bare = new THREE.Color();
  const applySeason = (season: SeasonState) => {
    for (const { material, kind } of seasonal) {
      summer.setHex(kind.summer);
      autumn.setHex(kind.autumn!);
      bare.setHex(kind.bare!);
      const leaves = Math.max(0, Math.min(1, season.leafDensity));
      material.color.copy(summer).lerp(autumn, season.autumnMix).lerp(bare, 1 - leaves);
    }
  };

  return {
    part: {
      object: group,
      // The instances' buffers.
      dispose: () => meshes.forEach((mesh) => mesh.dispose()),
    },
    applySeason,
  };
}
