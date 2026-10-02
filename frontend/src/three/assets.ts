/** Loading of the vendored CC0 texture assets.
 *
 * Everything lives under `public/assets/3d/` and is bundled with the app, so
 * the 3D view works with no network at all — a workshop venue's wifi is not
 * something this tool should depend on.
 */

import * as THREE from "three";

const FOLIAGE_ATLAS_URL = "assets/3d/foliage-atlas.png";

let foliageAtlas: Promise<THREE.Texture> | null = null;

/** Cached across scene rebuilds — the scene graph is thrown away and rebuilt
 * on every edit, but re-decoding the texture each time would be wasteful. */
export function loadFoliageAtlas(): Promise<THREE.Texture> {
  if (!foliageAtlas) {
    foliageAtlas = new THREE.TextureLoader().loadAsync(FOLIAGE_ATLAS_URL).then((texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      // Repeating, not clamped: each leaf cluster samples the sheet (see
      // foliageCards.ts's FOLIAGE_UV_REPEAT), and wrapping is harmless here
      // since every part of the sheet is foliage. Evergreens don't use this
      // atlas at all — see builders/needles.ts, which is geometric rather
      // than textured.
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      return texture;
    });
  }
  return foliageAtlas;
}

/** Tiling ground textures, and the real-world size one tile covers.
 *
 * Every surface in the scene carries UVs in *metres* — `ShapeGeometry` emits
 * shape-space coordinates, and `builders/paths.ts` measures its ribbons in
 * metres deliberately — so a texture is scaled to world size purely by setting
 * `repeat` to 1/tile-size. Get this wrong and paving stones come out either
 * the size of a fingernail or the size of a car.
 */
const GROUND_TEXTURES: Record<string, number> = {
  paving: 2.0,
  sett: 1.6,
  lawn: 3.0,
  asphalt: 4.0,
  gravel: 2.0,
};

export interface GroundTextureSet {
  map: THREE.Texture;
  /** Derived from the diffuse photo's own luminance (see
   * scripts/generate-ground-detail-maps.mjs) rather than a downloaded PBR
   * set — there's no matched normal/roughness source for these specific
   * tiles, and fetching an unrelated one would fight the diffuse photo's
   * actual stone/blade/grain layout instead of reinforcing it. */
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

let groundTextures: Promise<Map<string, GroundTextureSet>> | null = null;

export function loadGroundTextures(): Promise<Map<string, GroundTextureSet>> {
  if (!groundTextures) {
    const loader = new THREE.TextureLoader();
    groundTextures = Promise.all(
      Object.entries(GROUND_TEXTURES).map(async ([key, tileMetres]) => {
        const [map, normalMap, roughnessMap] = await Promise.all([
          loader.loadAsync(`assets/3d/ground/${key}.jpg`),
          loader.loadAsync(`assets/3d/ground/${key}_normal.jpg`),
          loader.loadAsync(`assets/3d/ground/${key}_roughness.jpg`),
        ]);
        map.colorSpace = THREE.SRGBColorSpace;
        // Normal/roughness are data, not colour — they must stay linear, or
        // the sRGB decode meant for photos would skew every sampled value.
        normalMap.colorSpace = THREE.NoColorSpace;
        roughnessMap.colorSpace = THREE.NoColorSpace;
        for (const texture of [map, normalMap, roughnessMap]) {
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.repeat.set(1 / tileMetres, 1 / tileMetres);
        }
        return [key, { map, normalMap, roughnessMap }] as const;
      })
    ).then((entries) => new Map(entries));
  }
  return groundTextures;
}

