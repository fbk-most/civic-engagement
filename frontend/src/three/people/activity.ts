/** How busy the square is, from the time of day and the season.
 *
 * Deliberately simple and explainable (see the crowd plan agreed for the 3D
 * view): the people in the scene are an illustration of how a public space
 * is typically used, not a prediction of attendance for this site. Felt
 * temperature then keeps some of them away, and changes where the others
 * stop and which way they walk (comfort.ts).
 */

import { daylightFraction, type SunSetting } from "../sun";

/** People, dogs and cars in the 3D view: hidden; in place but frozen, like
 * a picture; or moving, like a film. */
export type LifeMode = "off" | "still" | "live";
export const LIFE_MODES: LifeMode[] = ["off", "still", "live"];

export interface CrowdActivity {
  /** 0 (nobody around) to 1 (a busy summer evening). */
  level: number;
  /** 0 (empty streets) to 1 (rush hour) — cars keep their own hours. */
  traffic: number;
  /** After dusk: people only stay where there's light (see `planCrowd`). */
  dark: boolean;
}

// Share of the evening peak present at each hour (index = hour of day):
// quiet mornings, a lunchtime bump, the busiest stretch after work.
const HOURLY = [
  0.02, 0.01, 0.01, 0.01, 0.01, 0.03, 0.08, 0.2, 0.3, 0.35, 0.4, 0.5, 0.55, 0.5, 0.45, 0.5, 0.65, 0.85, 1, 0.95,
  0.8, 0.55, 0.3, 0.1,
];

// Traffic by hour: morning and evening rush hours, and it doesn't care much
// about the season.
const TRAFFIC_HOURLY = [
  0.05, 0.03, 0.02, 0.02, 0.03, 0.1, 0.35, 0.8, 1, 0.7, 0.55, 0.6, 0.7, 0.65, 0.6, 0.65, 0.75, 0.95, 1, 0.8, 0.55,
  0.4, 0.25, 0.12,
];

// Outdoor life by month (index = month - 1): a winter square is emptier.
const MONTHLY = [0.45, 0.5, 0.65, 0.8, 0.95, 1, 1, 0.9, 0.95, 0.8, 0.6, 0.5];

export function crowdActivity(setting: SunSetting, sunAltitudeDeg: number): CrowdActivity {
  const hour = ((setting.hour % 24) + 24) % 24;
  const i = Math.floor(hour);
  const f = hour - i;
  const at = (curve: number[]) => curve[i] * (1 - f) + curve[(i + 1) % 24] * f;
  const level = at(HOURLY) * MONTHLY[setting.month - 1];
  // Quantized so dragging the hour slider doesn't replan the crowd on every
  // pixel — people only appear/leave in visible steps anyway.
  const quantize = (value: number) => Math.round(value * 40) / 40;
  return {
    level: quantize(level),
    traffic: quantize(at(TRAFFIC_HOURLY)),
    dark: daylightFraction(sunAltitudeDeg) < 0.5,
  };
}
