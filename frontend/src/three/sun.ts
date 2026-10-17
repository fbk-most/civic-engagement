/** Real solar position for the site, driving the 3D view's sun.
 *
 * This is the second time axis in the tool and must not be confused with the
 * first. `TimeSlider` moves the *scenario* forward in years (trees grow, aging
 * trees are felled); this moves the clock *within* a year (where the sun is,
 * and therefore where the shade falls). A facilitator needs both: "what will
 * this square look like in 10 years" and "will I be able to sit here in July".
 *
 * The calendar *year* is deliberately not a field here — letting this pick an
 * arbitrary year clashed with the scenario slider (two controls both claiming
 * to say "what year is it"). The year is always `CURRENT_YEAR + t`; only
 * month/day/hour are this control's own concern.
 *
 * Sun angles come from suncalc, whose `getPosition` returns degrees with
 * azimuth measured clockwise from north — i.e. already a compass bearing, so
 * it feeds `bearingToDirection` directly.
 */

import * as THREE from "three";
import { getPosition } from "suncalc";
import { bearingToDirection } from "./geo";

export const CURRENT_YEAR = new Date().getFullYear();

export interface SunSetting {
  /** 1-12. */
  month: number;
  day: number;
  /** Hour of the day, local civil time, as a float (13.5 = 13:30). */
  hour: number;
}

/** One-click jumps to the dates that actually matter for a shade discussion:
 * the two solstices bound the year's range of sun heights, and the equinox
 * sits between them. */
export const SEASON_PRESETS = [
  { key: "winter", label: ["Solstizio d'inverno", "Winter solstice"], month: 12, day: 21 },
  { key: "equinox", label: ["Equinozio", "Equinox"], month: 3, day: 21 },
  { key: "summer", label: ["Solstizio d'estate", "Summer solstice"], month: 6, day: 21 },
] as const;

/** Mid-afternoon in high summer: the moment a square's lack of shade is most
 * keenly felt, and so the most useful default to open on. */
export const DEFAULT_SUN_SETTING: SunSetting = { month: 6, day: 21, hour: 15 };

export function formatHour(hour: number): string {
  // Rounded as a whole, so 11.999 reads 12:00 rather than 11:60.
  const total = Math.round(hour * 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Last valid day for `setting.month` in `year` (handles leap Februaries) —
 * used to clamp the day field so choosing a short month never leaves an
 * impossible date selected. */
export function daysInMonth(month: number, year: number): number {
  return new Date(year, month, 0).getDate();
}

/** Builds the instant to ask suncalc about.
 *
 * `new Date(y, m, d, h, min)` is interpreted in the *browser's* timezone, which
 * for a facilitator running the tool in Trento is the intended local civil
 * time (CET/CEST, DST included). Running the tool from another timezone would
 * shift the sun; that's an acceptable simplification for a site-specific
 * workshop instrument.
 */
export function sunSettingToDate(setting: SunSetting, year: number): Date {
  const hours = Math.floor(setting.hour);
  const minutes = Math.round((setting.hour - hours) * 60);
  return new Date(year, setting.month - 1, setting.day, hours, minutes);
}

export interface SunPosition {
  /** Unit vector pointing from the site *towards* the sun. */
  direction: THREE.Vector3;
  altitudeDeg: number;
  azimuthDeg: number;
}

/** 0 (sun below the fade window) to 1 (sun fully up), ramping over the last
 * 6 degrees before sunrise/sunset rather than snapping to black. Shared so
 * the sun/ambient crossfade (Lighting.ts), the streetlights' night switch-on
 * (builders/streetlights.ts) and the water's sun specular (builders/water.ts)
 * all fade in lockstep instead of each guessing the same curve separately. */
export function daylightFraction(altitudeDeg: number): number {
  return Math.min(1, Math.max(0, altitudeDeg) / 6);
}

/** Linear interpolation between (month, value) control points, holding flat
 * before the first and after the last — the shared mechanism behind
 * `leafDensity`/`autumnMix` below. Month-granularity only (matching
 * `SunControl`'s discrete month picker): no day-of-year precision, so this
 * is a rough temperate-climate approximation for Trento, not a phenology
 * model. */
function piecewiseLinear(points: Array<[month: number, value: number]>, month: number): number {
  if (month <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [prevMonth, prevValue] = points[i - 1];
    const [nextMonth, nextValue] = points[i];
    if (month <= nextMonth) {
      return prevValue + (nextValue - prevValue) * ((month - prevMonth) / (nextMonth - prevMonth));
    }
  }
  return points[points.length - 1][1];
}

// The felt-temperature field uses the same curve for how much sun crowns
// let through (LEAF_DENSITY_BY_MONTH in civic_twin/domains/urban/parameters.py):
// keep the two equal.
const LEAF_DENSITY_POINTS: Array<[number, number]> = [
  [1, 0],
  [3, 0],
  [4, 0.5],
  [5, 1],
  [9, 1],
  [10, 0.55],
  [11, 0.1],
  [12, 0],
];

const AUTUMN_MIX_POINTS: Array<[number, number]> = [
  [1, 0],
  [8, 0],
  [9, 0.35],
  [10, 0.85],
  [11, 1],
];

/** 0 (bare) to 1 (full canopy) — the seasonal leaf-out/leaf-drop knob for
 * deciduous trees (see `builders/foliageCards.ts`). Evergreens ignore this
 * entirely and stay at a constant 1. */
export function leafDensity(month: number): number {
  return piecewiseLinear(LEAF_DENSITY_POINTS, month);
}

/** 0 (summer green) to 1 (full autumn colour) — how far a deciduous tree's
 * leaf-card palette is lerped toward `foliageCards.ts`'s autumn palette.
 * Evergreens ignore this and stay at a constant 0. */
export function autumnMix(month: number): number {
  return piecewiseLinear(AUTUMN_MIX_POINTS, month);
}

export interface SeasonState {
  leafDensity: number;
  autumnMix: number;
}

/** Bundles both season curves for a given month — the single value
 * `View3D.tsx` computes once from `sunSetting.month` and threads down
 * through `Viewer`/`SceneBuilder` to `builders/vegetation.ts`. */
export function seasonState(month: number): SeasonState {
  return { leafDensity: leafDensity(month), autumnMix: autumnMix(month) };
}

export function sunPosition(setting: SunSetting, year: number, lat: number, lng: number): SunPosition {
  const { altitude, azimuth } = getPosition(sunSettingToDate(setting, year), lat, lng);
  const altitudeRad = (altitude * Math.PI) / 180;
  const horizontal = Math.cos(altitudeRad);
  const [dx, dz] = bearingToDirection(azimuth);

  return {
    direction: new THREE.Vector3(dx * horizontal, Math.sin(altitudeRad), dz * horizontal),
    altitudeDeg: altitude,
    azimuthDeg: azimuth,
  };
}
