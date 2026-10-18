/** The covers painted onto the terrain, instead of laid on it as meshes
 * (`FrontendPack.scene3d.paintCovers`): one texture over the terrain grid,
 * each cover filled with its surface colour, later covers over earlier
 * ones (the same precedence as the meshes and the space use indicator).
 * Cut along the grid, the meshes cost about as many triangles as the
 * terrain itself on a valley site; painted, none. The edges are soft, a
 * pixel or so — fine for a forest's edge, not for a square's paving, which
 * is why it's the pack's choice.
 */

import * as THREE from "three";
import type { CoverPolygon } from "../../api/types";
import { activePack } from "../../pack";
import { polygonRings, toLocal, type GeoAnchor } from "../geo";
import type { LocalGrid } from "../terrain";

/** Metres per pixel, at best; coarser on a site too large for MAX_PIXELS. */
const METRES_PER_PIXEL = 2;
const MAX_PIXELS = 4096;

export interface CoverPaint {
  texture: THREE.Texture;
  /** The local-frame x, z of the texture's (0, 0) corner, and its size in
   * metres: u runs east, v south. */
  origin: [number, number];
  size: [number, number];
}

/** Null where there's no 2D canvas to paint on (not in a browser).
 * `colorOf` gives a cover type's colour (null to leave it out), and
 * `background` the bare ground's. */
export function paintCovers(
  covers: CoverPolygon[],
  anchor: GeoAnchor,
  grid: LocalGrid,
  colorOf: (coverType: string) => THREE.Color | null,
  background: THREE.Color
): CoverPaint | null {
  const width = (grid.cols - 1) * grid.cellM;
  const height = (grid.rows - 1) * grid.cellM;
  const metresPerPixel = Math.max(METRES_PER_PIXEL, Math.max(width, height) / MAX_PIXELS);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width / metresPerPixel);
  canvas.height = Math.ceil(height / metresPerPixel);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const water = new Set(activePack().scene3d.waterCoverTypes);
  ctx.fillStyle = `#${background.getHexString()}`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const cover of covers) {
    // Ponds are drawn by builders/water.ts.
    if (water.has(cover.cover_type)) continue;
    const color = colorOf(cover.cover_type);
    if (!color) continue;
    ctx.fillStyle = `#${color.getHexString()}`;
    ctx.beginPath();
    for (const rings of polygonRings(cover.geometry)) {
      for (const ring of rings) {
        ring.forEach(([lng, lat], i) => {
          const [x, z] = toLocal(anchor, lng, lat);
          const px = (x - grid.x0) / metresPerPixel;
          const py = (z - grid.z0) / metresPerPixel;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
      }
    }
    // Holes (a clearing in a stand) stay unpainted.
    ctx.fill("evenodd");
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Rows run south, as the local frame's z.
  texture.flipY = false;
  texture.anisotropy = 8;
  return {
    texture,
    origin: [grid.x0, grid.z0],
    size: [canvas.width * metresPerPixel, canvas.height * metresPerPixel],
  };
}
