/** Cheap streetlight lighting, computed in the materials themselves (the
 * default; `?lights=all` turns it off — see builders/streetlights.ts).
 *
 * three.js shades every lit pixel against every active light, with the full
 * physically-based model (diffuse and specular) — with one real light per
 * lamp (~75-120 per site) that made night frames several times slower than
 * day ones. Here, instead, every lamp adds the same light a real one would
 * (same colour, range, falloff, highlights) minus the shadows, and each
 * pixel only considers the lamps whose range can reach it: lamp positions are
 * binned into a grid of square cells, and a pixel looks up its cell's short
 * list. The few lamps nearest the camera stay real lights (with shadows and
 * highlights) and are left out of the lists, so nothing is lit twice.
 *
 * The code is injected into three's MeshStandardMaterial shader through
 * `onBeforeCompile`, which ties it to the shader chunks of the three version
 * in use (0.185): an upgrade may need these hooks revisited.
 */

import * as THREE from "three";
import { readDebugParams } from "../debugParams";

export const LAMP_LIGHTING = readDebugParams().nightLights === "cheap";

// Lamps listed per grid cell, as RGBA texels of four indices each.
const SLOTS_PER_CELL = 12;
const TEXELS_PER_CELL = SLOTS_PER_CELL / 4;
const MAX_GRID_ROWS = 4096;

/** Shared by every patched material: updating a value updates them all.
 * Each 3D view keeps its own lamps (`LampLighting`) and makes them these
 * values before it renders (`activate`): two views side by side draw their
 * own lamps, and the materials shared between them (the people's, the
 * cars') see the lamps of the view being drawn. */
const uniforms = {
  lampData: { value: emptyTexture(1, 1) as THREE.DataTexture },
  lampGrid: { value: emptyTexture(TEXELS_PER_CELL, 1) as THREE.DataTexture },
  lampGridOrigin: { value: new THREE.Vector2() },
  lampCellSize: { value: 1 },
  lampGridCols: { value: 1 },
  lampGridRows: { value: 1 },
  lampColor: { value: new THREE.Color() },
  /** Candela, as a real PointLight's intensity; 0 by day (skips the work). */
  lampIntensity: { value: 0 },
  lampRange: { value: 1 },
};

function emptyTexture(width: number, height: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Float32Array(width * height * 4).fill(-1), width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return texture;
}

/** One 3D view's lamps (its MaterialLibrary's `lamps`): where they are, which
 * have a real light, how bright they are. */
export class LampLighting {
  private lamps: THREE.Vector3[] = [];
  private lampData = emptyTexture(1, 1);
  private lampGrid = emptyTexture(TEXELS_PER_CELL, 1);
  private readonly gridOrigin = new THREE.Vector2();
  private cellSize = 1;
  private gridCols = 1;
  private gridRows = 1;
  private readonly color = new THREE.Color();
  private intensity = 0;
  private range = 1;

  /** Where the lamps are, and how far they reach: rebuilds the lamp list
   * and the grid. Call on every scene build. */
  setLayout(positions: THREE.Vector3[], range: number, color: THREE.ColorRepresentation): void {
    this.lamps = positions;
    this.color.set(color);
    this.range = range;

    const data = new Float32Array(Math.max(1, positions.length) * 4);
    positions.forEach((p, i) => data.set([p.x, p.y, p.z, 1], i * 4));
    this.lampData.dispose();
    this.lampData = new THREE.DataTexture(data, Math.max(1, positions.length), 1, THREE.RGBAFormat, THREE.FloatType);
    this.lampData.needsUpdate = true;

    if (positions.length === 0) return;
    const minX = Math.min(...positions.map((p) => p.x)) - range;
    const maxX = Math.max(...positions.map((p) => p.x)) + range;
    const minZ = Math.min(...positions.map((p) => p.z)) - range;
    const maxZ = Math.max(...positions.map((p) => p.z)) + range;
    // Cells about the size of a lamp's reach: small enough that a cell's list
    // stays short, and never so many that the grid texture outgrows limits.
    let cell = Math.max(8, range);
    while (Math.ceil((maxX - minX) / cell) * Math.ceil((maxZ - minZ) / cell) > MAX_GRID_ROWS) cell *= 1.25;
    const cols = Math.ceil((maxX - minX) / cell);
    const rows = Math.ceil((maxZ - minZ) / cell);

    const grid = new Float32Array(cols * rows * TEXELS_PER_CELL * 4).fill(-1);
    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        // Lamps that can reach any point of the cell, nearest its centre first.
        const x0 = minX + cx * cell;
        const z0 = minZ + cz * cell;
        const reaching = positions
          .map((p, index) => {
            const dx = Math.max(x0 - p.x, 0, p.x - (x0 + cell));
            const dz = Math.max(z0 - p.z, 0, p.z - (z0 + cell));
            return { index, reach: Math.hypot(dx, dz), centre: Math.hypot(p.x - (x0 + cell / 2), p.z - (z0 + cell / 2)) };
          })
          .filter((lamp) => lamp.reach <= range)
          .sort((a, b) => a.centre - b.centre)
          .slice(0, SLOTS_PER_CELL);
        const base = (cz * cols + cx) * SLOTS_PER_CELL;
        reaching.forEach((lamp, slot) => (grid[base + slot] = lamp.index));
      }
    }
    this.lampGrid.dispose();
    this.lampGrid = new THREE.DataTexture(grid, TEXELS_PER_CELL, cols * rows, THREE.RGBAFormat, THREE.FloatType);
    this.lampGrid.needsUpdate = true;
    this.gridOrigin.set(minX, minZ);
    this.cellSize = cell;
    this.gridCols = cols;
    this.gridRows = rows;
  }

  /** Lamps currently served by a real light (left out here, so they don't
   * light things twice). */
  setReal(served: Set<number>): void {
    const data = this.lampData.image.data as Float32Array;
    this.lamps.forEach((_, i) => (data[i * 4 + 3] = served.has(i) ? 0 : 1));
    this.lampData.needsUpdate = true;
  }

  setIntensity(intensity: number): void {
    this.intensity = intensity;
  }

  /** Makes these the lamps every patched material draws: before each
   * render of the view. */
  activate(): void {
    uniforms.lampData.value = this.lampData;
    uniforms.lampGrid.value = this.lampGrid;
    uniforms.lampGridOrigin.value.copy(this.gridOrigin);
    uniforms.lampCellSize.value = this.cellSize;
    uniforms.lampGridCols.value = this.gridCols;
    uniforms.lampGridRows.value = this.gridRows;
    uniforms.lampColor.value.copy(this.color);
    uniforms.lampIntensity.value = this.intensity;
    uniforms.lampRange.value = this.range;
  }

  dispose(): void {
    this.lampData.dispose();
    this.lampGrid.dispose();
  }
}

const VERTEX_DECLARATIONS = /* glsl */ `
varying vec3 vLampWorldPosition;
`;

// After project_vertex, `transformed` is the final (skinned, morphed)
// model-space position; instancing and batching apply their own matrices.
const VERTEX_BODY = /* glsl */ `
{
  vec4 lampPosition = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    lampPosition = batchingMatrix * lampPosition;
  #endif
  #ifdef USE_INSTANCING
    lampPosition = instanceMatrix * lampPosition;
  #endif
  vLampWorldPosition = (modelMatrix * lampPosition).xyz;
}
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
varying vec3 vLampWorldPosition;
uniform sampler2D lampData;
uniform sampler2D lampGrid;
uniform vec2 lampGridOrigin;
uniform float lampCellSize;
uniform float lampGridCols;
uniform float lampGridRows;
uniform vec3 lampColor;
uniform float lampIntensity;
uniform float lampRange;
`;

// Runs after three's own lights, through the very same render equation
// (RE_Direct: diffuse and specular) a PointLight goes through, just without
// the shadow — so a lamp switching between a real light and this one only
// gains or loses its shadows, not its highlights. Lighting is in view space,
// like three's; `geometry*` come from lights_fragment_begin.
const FRAGMENT_BODY = /* glsl */ `
if (lampIntensity > 0.0) {
  vec2 lampCell = floor((vLampWorldPosition.xz - lampGridOrigin) / lampCellSize);
  if (lampCell.x >= 0.0 && lampCell.y >= 0.0 && lampCell.x < lampGridCols && lampCell.y < lampGridRows) {
    int lampRow = int(lampCell.y * lampGridCols + lampCell.x);
    IncidentLight lampLight;
    lampLight.visible = true;
    for (int texel = 0; texel < ${TEXELS_PER_CELL}; texel++) {
      vec4 ids = texelFetch(lampGrid, ivec2(texel, lampRow), 0);
      for (int k = 0; k < 4; k++) {
        float id = ids[k];
        if (id < 0.0) break;
        vec4 lamp = texelFetch(lampData, ivec2(int(id), 0), 0);
        if (lamp.w < 0.5) continue;
        vec3 toLamp = (viewMatrix * vec4(lamp.xyz, 1.0)).xyz - geometryPosition;
        float lampDistance = length(toLamp);
        if (lampDistance >= lampRange) continue;
        lampLight.direction = toLamp / lampDistance;
        lampLight.color = lampColor * lampIntensity * getDistanceAttenuation(lampDistance, lampRange, 2.0);
        RE_Direct(lampLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
      }
    }
  }
}
`;

/** Adds the cheap lamp lighting to a MeshStandardMaterial, keeping any
 * shader tweak it already has. Does nothing with `?lights=all`. */
export function addLampLighting<T extends THREE.Material>(material: T): T {
  if (!LAMP_LIGHTING) return material;
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_DECLARATIONS}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_DECLARATIONS}`)
      .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>\n${FRAGMENT_BODY}`);
  };
  material.customProgramCacheKey = () => `${previousKey()}|lamp-lighting`;
  return material;
}
