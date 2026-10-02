#!/usr/bin/env node
/** Derives normal + roughness maps for the vendored ground diffuse textures.
 *
 * There is no CC0 PBR source for these specific tiles (only the diffuse
 * photos already under public/assets/3d/ground/), and downloading a matched
 * normal/roughness set would break the project's offline-first, no-network
 * asset stance. Instead this treats the diffuse photo's own luminance as a
 * height field and derives a normal map from it — a standard technique for
 * turning a photographed surface into relief without new source assets.
 * Output is JPEG, same as the source photos, and for the same reason —
 * lossless PNG ran 3+MB total for five tiles' normal+roughness maps, JPEG
 * ran ~400KB with no visible difference at this level of (heavily blurred)
 * detail. Run once, offline, at asset-prep time (not part of the app
 * build); output is committed to the repo like the diffuse jpgs it's
 * derived from.
 *
 * Usage: node scripts/generate-ground-detail-maps.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import jpeg from "jpeg-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GROUND_DIR = path.join(__dirname, "..", "public", "assets", "3d", "ground");

/** Mirrors GROUND_TEXTURES' tile size in assets.ts — needed to convert a
 * pixel-space gradient into a real slope (metres of relief per metre of
 * ground), which is what makes the bump scale correctly at world size
 * instead of per-texture-key by accident. */
const SURFACES = {
  // Individual stones/slabs are the whole visual point of these two, so they
  // get the most relief.
  sett: { tileMetres: 1.6, reliefM: 0.03, roughnessVariation: 0.35 },
  paving: { tileMetres: 2.0, reliefM: 0.012, roughnessVariation: 0.2 },
  gravel: { tileMetres: 2.0, reliefM: 0.02, roughnessVariation: 0.3 },
  lawn: { tileMetres: 3.0, reliefM: 0.008, roughnessVariation: 0.15 },
  asphalt: { tileMetres: 4.0, reliefM: 0.004, roughnessVariation: 0.1 },
};

function luminance(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 3x3 box blur on the height field, so the normal map reads as surface
 * relief rather than amplified JPEG noise. */
function blur(height, width, rows) {
  const out = new Float32Array(height.length);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          // Wrapped, matching the texture's RepeatWrapping so the map tiles
          // seamlessly instead of seaming at every repeat.
          const sx = (x + dx + width) % width;
          const sy = (y + dy + rows) % rows;
          sum += height[sy * width + sx];
        }
      }
      out[y * width + x] = sum / 9;
    }
  }
  return out;
}

async function processSurface(key, config) {
  const srcPath = path.join(GROUND_DIR, `${key}.jpg`);
  const raw = await readFile(srcPath);
  const { width, height: rows, data } = jpeg.decode(raw, { useTArray: true });

  const heightField = new Float32Array(width * rows);
  let meanLuminance = 0;
  for (let i = 0; i < width * rows; i++) {
    const l = luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    heightField[i] = l;
    meanLuminance += l;
  }
  meanLuminance /= width * rows;
  // Two passes: the diffuse photos carry JPEG compression artifacts and
  // sensor grain at the single-pixel scale, which a normal map amplifies
  // into visible sparkle rather than surface relief. This also keeps the
  // derived maps low-frequency enough to compress well as JPEG themselves.
  const smoothed = blur(blur(heightField, width, rows), width, rows);

  const texelWorldM = config.tileMetres / width;
  const normalData = new Uint8Array(width * rows * 4);
  const roughnessData = new Uint8Array(width * rows * 4);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const xL = smoothed[y * width + ((x - 1 + width) % width)];
      const xR = smoothed[y * width + ((x + 1) % width)];
      const yU = smoothed[((y - 1 + rows) % rows) * width + x];
      const yD = smoothed[((y + 1) % rows) * width + x];

      const dHdx = ((xR - xL) * config.reliefM) / (2 * texelWorldM);
      // Texture-space V increases downward on the canvas but three's UV.y
      // increases upward; leaving this un-flipped is the OpenGL tangent-space
      // convention three.js expects by default (normalMapType is left at its
      // default TangentSpaceNormalMap), so no sign flip belongs here.
      const dHdy = ((yD - yU) * config.reliefM) / (2 * texelWorldM);

      let nx = -dHdx;
      let ny = -dHdy;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;

      const idx = (y * width + x) * 4;
      normalData[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      normalData[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalData[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normalData[idx + 3] = 255;

      // Multiplier around 1.0 (three multiplies this against
      // material.roughness), not an absolute value — darker/recessed areas
      // (grout, gaps between stones) read as rougher, worn high points as
      // smoother, without changing the surface's overall roughness level.
      const l = heightField[y * width + x];
      const multiplier = clamp(1 + (l - meanLuminance) * config.roughnessVariation, 0.6, 1.25);
      const gray = Math.round(multiplier * 200);
      roughnessData[idx] = gray;
      roughnessData[idx + 1] = gray;
      roughnessData[idx + 2] = gray;
      roughnessData[idx + 3] = 255;
    }
  }

  // JPEG rather than PNG: these maps are subtle, low-frequency relief (after
  // the double blur above), and JPEG's compression artifacts at that scale
  // are invisible against a >10x size win — the same "vendored, offline,
  // small" trade the diffuse photos next to them already made.
  const normalJpeg = jpeg.encode({ data: normalData, width, height: rows }, 88);
  const roughnessJpeg = jpeg.encode({ data: roughnessData, width, height: rows }, 82);
  await writeFile(path.join(GROUND_DIR, `${key}_normal.jpg`), normalJpeg.data);
  await writeFile(path.join(GROUND_DIR, `${key}_roughness.jpg`), roughnessJpeg.data);
  console.log(`${key}: wrote ${key}_normal.jpg, ${key}_roughness.jpg (${width}x${rows})`);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

for (const [key, config] of Object.entries(SURFACES)) {
  await processSurface(key, config);
}
