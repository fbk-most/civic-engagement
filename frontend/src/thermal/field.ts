/** The felt-temperature field as the views use it: decoded once, read at any
 * hour (blending the two hourly layers around it), coloured on one scale
 * shared by the 2D map and the 3D view.
 *
 * The backend computes it (bologna-civic-dt's bologna_civic_dt/thermal_field.py): felt
 * temperature 1.1 m above the ground, per 1 m cell, for each hour of one
 * day. Like the 3D view, it is an indication, not a measurement.
 */

import type { FieldGrid, ThermalFieldResponse } from "../api/types";

export interface ThermalField {
  grid: FieldGrid;
  date: string;
  hours: number;
  /** °C per cell, hour by hour, rows from the south; NaN where nothing is
   * computed (outside the site, inside buildings). */
  values: Float32Array;
  airTemperature: number[];
  meanFelt: number[];
  heatStressPct: number[];
  sunlitPct: number[];
}

/** Opacity factor for another day's field, standing in (on the map and in
 * the 3D view) while the right one loads. */
export const STALE_DIMMING = 0.5;

/** A felt temperature read off the field: under the pointer, or where the
 * person walking the 3D view stands. */
export type ThermalReading = { celsius: number; where: "pointer" | "here" } | null;

export function decodeField(response: ThermalFieldResponse): ThermalField {
  const bytes = Uint8Array.from(atob(response.data), (c) => c.charCodeAt(0));
  const values = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    values[i] = bytes[i] === response.nodata ? NaN : response.offset + bytes[i] * response.scale;
  }
  return {
    grid: response.grid,
    date: response.date,
    hours: response.hours,
    values,
    airTemperature: response.air_temperature_c,
    meanFelt: response.mean_felt_c,
    heatStressPct: response.heat_stress_pct,
    sunlitPct: response.sunlit_pct,
  };
}

/** Linear blend between the hourly layers around `hour` (a float, local
 * time); wraps from 23:00 to midnight. */
function blend(hour: number, hours: number): { h0: number; h1: number; f: number } {
  const wrapped = ((hour % hours) + hours) % hours;
  const h0 = Math.floor(wrapped);
  return { h0, h1: (h0 + 1) % hours, f: wrapped - h0 };
}

/** One layer: °C per cell at `hour`, rows from the south. */
export function layerAt(field: ThermalField, hour: number): Float32Array {
  const n = field.grid.nx * field.grid.ny;
  const { h0, h1, f } = blend(hour, field.hours);
  const a = field.values.subarray(h0 * n, (h0 + 1) * n);
  const b = field.values.subarray(h1 * n, (h1 + 1) * n);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] * (1 - f) + b[i] * f;
  return out;
}

/** A per-hour summary at `hour`, blended the same way. */
export function summaryAt(series: number[], hour: number): number {
  const { h0, h1, f } = blend(hour, series.length);
  return series[h0] * (1 - f) + series[h1] * f;
}

/** °C at a point of the local frame (metres east, metres north), or null
 * outside the computed cells. */
export function valueAt(field: ThermalField, layer: Float32Array, east: number, north: number): number | null {
  const { x0, y0, nx, ny, cell_m } = field.grid;
  const i = Math.floor((east - x0) / cell_m);
  const j = Math.floor((north - y0) / cell_m);
  if (i < 0 || i >= nx || j < 0 || j >= ny) return null;
  const v = layer[j * nx + i];
  return Number.isNaN(v) ? null : v;
}

// --- the colour scale ---------------------------------------------------------

/** Diverging: blue for cold, red for heat, a neutral grey at the middle of
 * the comfort band; lightness falls steadily from the middle to both ends
 * (checked in OKLab), so the scale reads as "more" either way. Anchored at
 * the UTCI stress thresholds. */
export const FELT_STOPS: [celsius: number, hex: string][] = [
  [-13, "#104281"],
  [0, "#2a78d6"],
  [9, "#86b6ef"],
  [18, "#f0efec"],
  [26, "#f5c39a"],
  [32, "#e8865e"],
  [38, "#e0302a"],
  [46, "#b8001f"],
];

/** UTCI's thermal stress categories, for the legend. */
export const STRESS_BANDS: { from: number | null; to: number | null; label: [it: string, en: string] }[] = [
  { from: null, to: -13, label: ["Freddo forte", "Strong cold"] },
  { from: -13, to: 0, label: ["Freddo moderato", "Moderate cold"] },
  { from: 0, to: 9, label: ["Fresco", "Cool"] },
  { from: 9, to: 26, label: ["Nessuno stress", "No stress"] },
  { from: 26, to: 32, label: ["Caldo moderato", "Moderate heat"] },
  { from: 32, to: 38, label: ["Caldo forte", "Strong heat"] },
  { from: 38, to: 46, label: ["Caldo molto forte", "Very strong heat"] },
  { from: 46, to: null, label: ["Caldo estremo", "Extreme heat"] },
];

const STOP_RGB = FELT_STOPS.map(([celsius, hex]) => ({
  celsius,
  rgb: [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)) as [number, number, number],
}));

export function feltColor(celsius: number): [number, number, number] {
  if (celsius <= STOP_RGB[0].celsius) return STOP_RGB[0].rgb;
  for (let k = 1; k < STOP_RGB.length; k++) {
    const hi = STOP_RGB[k];
    if (celsius <= hi.celsius) {
      const lo = STOP_RGB[k - 1];
      const f = (celsius - lo.celsius) / (hi.celsius - lo.celsius);
      return [0, 1, 2].map((c) => Math.round(lo.rgb[c] + (hi.rgb[c] - lo.rgb[c]) * f)) as [number, number, number];
    }
  }
  return STOP_RGB[STOP_RGB.length - 1].rgb;
}

/** A layer as RGBA pixels, north row first (image order); transparent
 * where there is no value. */
export function layerToRgba(field: ThermalField, layer: Float32Array): Uint8ClampedArray<ArrayBuffer> {
  const { nx, ny } = field.grid;
  const pixels = new Uint8ClampedArray(nx * ny * 4);
  for (let j = 0; j < ny; j++) {
    const row = ny - 1 - j;
    for (let i = 0; i < nx; i++) {
      const v = layer[j * nx + i];
      if (Number.isNaN(v)) continue;
      const [r, g, b] = feltColor(v);
      const p = (row * nx + i) * 4;
      pixels[p] = r;
      pixels[p + 1] = g;
      pixels[p + 2] = b;
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}
