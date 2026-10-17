/** The felt-temperature field in the 3D view: a semi-transparent sheet at
 * about chest height (OVERLAY_HEIGHT_M) over the site, coloured on the same
 * scale as the 2D map's layer (thermal/field.ts). Unlit: it is a reading of
 * the model drawn into the scene, not a thing in it, so the sun, the night
 * and the shadows don't change its colours.
 *
 * Nor does the tone mapping. The view tone-maps the whole frame once, at the
 * end (OutputPass), so `toneMapped: false` has no effect on a material; the
 * sheet's colours are pre-compensated instead (`untoneMapped`), so the
 * sheet comes out of the tone mapping in the legend's colours — exactly
 * where it's opaque, and close where the scene shows through.
 */

import * as THREE from "three";
import { feltColor, STALE_DIMMING, type ThermalField } from "../thermal/field";

// Where people feel it (the field is computed at 1.1 m), low enough to read
// as "on the ground" from the overview.
export const OVERLAY_HEIGHT_M = 1.0;
// From above, a little more opaque than the 2D layer: the realistic ground
// under it (grass, dark water, asphalt) shifts its colours away from the
// legend's. From eye level, where the sheet fills the lower half of the
// view just below the eye, less, or it hides the square itself.
const OPACITY_ABOVE = 0.55;
const OPACITY_EYE_LEVEL = 0.35;
const EYE_LEVEL_M = 2;
const ABOVE_M = 30;

// --- undoing three's ACES filmic tone mapping (tonemapping_pars_fragment) ---------

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3]; // rows

// The shader's matrices, as rows (the GLSL source lists columns).
const ACES_INPUT: Mat3 = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
const ACES_OUTPUT: Mat3 = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

function multiply(m: Mat3, v: Vec3): Vec3 {
  return m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]) as Vec3;
}

function invert(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

const ACES_INPUT_INVERSE = invert(ACES_INPUT);
const ACES_OUTPUT_INVERSE = invert(ACES_OUTPUT);

/** Inverse of RRTAndODTFit, (v (v + a) - b) / (v (c v + d) + e) = w: the
 * positive root of a quadratic. Saturates just under the curve's ceiling. */
function inverseFit(w: number): number {
  const [a, b, c, d, e] = [0.0245786, 0.000090537, 0.983729, 0.432951, 0.238081];
  const y = Math.min(Math.max(w, 0), 0.99 / c);
  const qa = 1 - y * c;
  const qb = a - y * d;
  const qc = -(b + y * e);
  return (-qb + Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
}

/** The linear colour that three's ACES filmic tone mapping, at `exposure`,
 * turns into the sRGB colour `rgb` (0-255) — or the nearest it can, for
 * colours outside what the tone mapping can produce. */
export function untoneMapped(rgb: Vec3, exposure: number): Vec3 {
  const display = new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  const fitted = multiply(ACES_OUTPUT_INVERSE, [display.r, display.g, display.b]).map(inverseFit) as Vec3;
  const scene = multiply(ACES_INPUT_INVERSE, fitted);
  return scene.map((c) => Math.max(c, 0) / (exposure / 0.6)) as Vec3;
}

// --- the sheet ---------------------------------------------------------------------

// Colours are looked up per 0.1 °C rather than recomputed per cell, already
// as half floats (the texture's format).
const LUT_MIN_C = -30;
const LUT_STEP_C = 0.1;
const LUT_SIZE = 900;

export class ThermalOverlay {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private texture: THREE.DataTexture | null = null;
  private gridKey = "";
  private readonly lut: Uint16Array;
  private dimming = 1;
  private viewHeight = ABOVE_M;

  /** `exposure`: the renderer's toneMappingExposure. */
  constructor(exposure: number) {
    this.lut = new Uint16Array(LUT_SIZE * 3);
    for (let k = 0; k < LUT_SIZE; k++) {
      const linear = untoneMapped(feltColor(LUT_MIN_C + k * LUT_STEP_C), exposure);
      this.lut.set(linear.map((c) => THREE.DataUtils.toHalfFloat(c)), k * 3);
    }
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: OPACITY_ABOVE,
      // Seen through, never hiding what's behind it from the depth test.
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.name = "thermal-overlay";
    this.mesh.visible = false;
    this.mesh.renderOrder = 10;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Out of the way of placard picking and anything else that raycasts.
    this.mesh.raycast = () => {};
  }

  /** Shows `layer` (one hour of `field`), or hides the sheet. `stale`:
   * another day's field, standing in while the right one loads — dimmed. */
  set(field: ThermalField | null, layer: Float32Array | null, stale = false): void {
    if (!field || !layer) {
      this.mesh.visible = false;
      return;
    }
    this.dimming = stale ? STALE_DIMMING : 1;
    this.setViewHeight(this.viewHeight);
    const { x0, y0, nx, ny, cell_m } = field.grid;
    const key = JSON.stringify(field.grid);
    if (key !== this.gridKey || !this.texture) {
      this.texture?.dispose();
      // Half floats: compensated colours go above 1. Linear, unlike the 2D
      // layer's sRGB pixels.
      this.texture = new THREE.DataTexture(new Uint16Array(nx * ny * 4), nx, ny, THREE.RGBAFormat, THREE.HalfFloatType);
      this.texture.colorSpace = THREE.LinearSRGBColorSpace;
      this.texture.magFilter = THREE.LinearFilter;
      this.texture.minFilter = THREE.LinearFilter;
      this.mesh.material.map = this.texture;
      this.mesh.material.needsUpdate = true;
      // The plane lies flat, its +Y turned to the north (-Z); the texture's
      // first row is its southern edge, as the field's.
      this.mesh.geometry.dispose();
      this.mesh.geometry = new THREE.PlaneGeometry(nx * cell_m, ny * cell_m);
      this.mesh.geometry.rotateX(-Math.PI / 2);
      this.mesh.position.set(x0 + (nx * cell_m) / 2, OVERLAY_HEIGHT_M, -(y0 + (ny * cell_m) / 2));
      this.gridKey = key;
    }
    const data = this.texture.image.data as Uint16Array;
    const one = THREE.DataUtils.toHalfFloat(1);
    const zero = THREE.DataUtils.toHalfFloat(0);
    for (let i = 0; i < layer.length; i++) {
      const v = layer[i];
      const p = i * 4;
      if (Number.isNaN(v)) {
        data[p] = data[p + 1] = data[p + 2] = data[p + 3] = zero;
        continue;
      }
      const k = Math.min(LUT_SIZE - 1, Math.max(0, Math.round((v - LUT_MIN_C) / LUT_STEP_C))) * 3;
      data[p] = this.lut[k];
      data[p + 1] = this.lut[k + 1];
      data[p + 2] = this.lut[k + 2];
      data[p + 3] = one;
    }
    this.texture.needsUpdate = true;
    this.mesh.visible = true;
  }

  /** Fades the sheet as the camera comes down to eye level. */
  setViewHeight(heightM: number): void {
    this.viewHeight = heightM;
    const f = Math.min(1, Math.max(0, (heightM - EYE_LEVEL_M) / (ABOVE_M - EYE_LEVEL_M)));
    this.mesh.material.opacity = (OPACITY_EYE_LEVEL + (OPACITY_ABOVE - OPACITY_EYE_LEVEL) * f) * this.dimming;
  }

  dispose(): void {
    this.texture?.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
