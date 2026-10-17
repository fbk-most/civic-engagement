import * as THREE from "three";
import type { MaterialLibrary } from "../materials";
import type { Terrain } from "../terrain";

/** Grid cells per side of one mesh: the surface comes in tiles, so that
 * the renderer can leave out the ones out of view. */
const TILE_CELLS = 64;

/** Below the ground's real height (`Terrain.heightAt`), which is where the
 * covers and paths lie: they win over the bare ground they're on without
 * relying on depth offsets alone. Unnoticeable, since nothing stands on
 * the bare surface itself but at `heightAt`. */
const SURFACE_DROP_M = 0.05;

/** The bare ground of a site with terrain: the grid's own triangles (see
 * three/terrain.ts), split in tiles. Covers are drawn over it, where there
 * are any. Nothing on a flat site — the covers are the ground. */
export function buildTerrainSurface(terrain: Terrain, materials: MaterialLibrary): THREE.Group {
  const group = new THREE.Group();
  group.name = "terrain";
  const grid = terrain.grid;
  if (!grid) return group;

  const material = materials.terrain();
  for (let row0 = 0; row0 < grid.rows - 1; row0 += TILE_CELLS) {
    for (let col0 = 0; col0 < grid.cols - 1; col0 += TILE_CELLS) {
      const cols = Math.min(TILE_CELLS, grid.cols - 1 - col0) + 1;
      const rows = Math.min(TILE_CELLS, grid.rows - 1 - row0) + 1;
      const positions = new Float32Array(cols * rows * 3);
      const normals = new Float32Array(cols * rows * 3);
      const uvs = new Float32Array(cols * rows * 2);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const x = grid.x0 + (col0 + c) * grid.cellM;
          const z = grid.z0 + (row0 + r) * grid.cellM;
          positions.set([x, grid.heights[(row0 + r) * grid.cols + col0 + c] - SURFACE_DROP_M, z], i * 3);
          normals.set(terrain.normalAt(x, z), i * 3);
          // In metres, as the covers' (see shapes.ts).
          uvs.set([x, -z], i * 2);
        }
      }
      // Each cell split along its (col, row)-(col + 1, row + 1) diagonal,
      // as `Terrain.heightAt` has it; counter-clockwise seen from above.
      const index: number[] = [];
      for (let r = 0; r + 1 < rows; r++) {
        for (let c = 0; c + 1 < cols; c++) {
          const a = r * cols + c;
          const b = a + 1;
          const d = a + cols;
          index.push(a, d + 1, b, a, d, d + 1);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      geometry.setIndex(index);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `terrain-${row0 / TILE_CELLS}-${col0 / TILE_CELLS}`;
      // Hills shade the valley.
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return group;
}
