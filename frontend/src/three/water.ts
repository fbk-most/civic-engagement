/** Procedural, seamlessly-tileable ripple normal map for the pond (see
 * `builders/water.ts`). Three's own Water object (the classic
 * webgl_shaders_ocean shader) expects a `waterNormals` texture the same way
 * its example ships a downloaded JPEG; generating one here instead keeps
 * this offline-first, the same call already made for the ground and facade
 * detail maps (see facade.ts, assets.ts).
 *
 * The height field is a sum of a handful of sine waves at small *integer*
 * wavenumbers, which is what makes it exactly periodic over the canvas — a
 * random/blob-based height field wouldn't tile without visible seams once
 * Water.js's shader scrolls and repeats it every frame.
 */

import * as THREE from "three";

const TEXTURE_PX = 256;

const WAVES: readonly { kx: number; ky: number; amplitude: number; phase: number }[] = [
  { kx: 3, ky: 1, amplitude: 1.0, phase: 0.0 },
  { kx: -2, ky: 4, amplitude: 0.6, phase: 1.3 },
  { kx: 5, ky: -3, amplitude: 0.35, phase: 2.7 },
  { kx: -6, ky: -2, amplitude: 0.2, phase: 4.1 },
];

function heightAt(x: number, y: number): number {
  let h = 0;
  for (const wave of WAVES) {
    const phase = (2 * Math.PI * (wave.kx * x + wave.ky * y)) / TEXTURE_PX + wave.phase;
    h += wave.amplitude * Math.sin(phase);
  }
  return h;
}

let cached: THREE.Texture | null = null;

export function waterNormalTexture(): THREE.Texture {
  if (cached) return cached;

  const heights = new Float32Array(TEXTURE_PX * TEXTURE_PX);
  for (let y = 0; y < TEXTURE_PX; y++) {
    for (let x = 0; x < TEXTURE_PX; x++) heights[y * TEXTURE_PX + x] = heightAt(x, y);
  }
  const at = (x: number, y: number) =>
    heights[((y + TEXTURE_PX) % TEXTURE_PX) * TEXTURE_PX + ((x + TEXTURE_PX) % TEXTURE_PX)];

  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_PX;
  canvas.height = TEXTURE_PX;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(TEXTURE_PX, TEXTURE_PX);

  // Water.js's shader reads this map as (R, G, B) = (world X tilt, world Z
  // tilt, "up") — see its `noise.xzy` swizzle — which is the same local
  // (x, y, z-as-normal) convention shapes.ts's flatGeometry rotates into
  // world (x, z, y) everywhere else in this codebase, so x/y below line up
  // with R/G without needing any extra remapping.
  for (let y = 0; y < TEXTURE_PX; y++) {
    for (let x = 0; x < TEXTURE_PX; x++) {
      const dHdx = (at(x + 1, y) - at(x - 1, y)) / 2;
      const dHdy = (at(x, y + 1) - at(x, y - 1)) / 2;

      let nx = -dHdx;
      let ny = -dHdy;
      let nz = 3; // large relative to nx/ny: gentle ripples, not a jagged sea
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;

      const idx = (y * TEXTURE_PX + x) * 4;
      image.data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      image.data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      image.data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      image.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  cached = texture;
  return texture;
}
