/** URL-driven initial state, for reproducing an exact 3D view outside the
 * interactive app — a headless browser (or anyone else) can load
 * `?viewer=1&t=5&month=6&day=21&hour=5.5&lng=...&lat=...&eyeHeight=...&bearing=...&pitch=...&fov=...&life=still`
 * and land on precisely that scenario year, sun position, and camera pose,
 * instead of a screenshot-and-describe round trip for every rendering issue.
 * `View3D`'s "Copia URL vista" button builds this same URL from the
 * live view, so the loop closes in both directions.
 *
 * Every parameter read here is listed, with its values, in the README's
 * "URL parameters" section — keep the two in step.
 */

import { DEFAULT_FOV_DEG, type CameraPose } from "./three/camera";
import type { SunSetting } from "./three/sun";
import { LIFE_MODES, type LifeMode } from "./three/people/activity";

export interface DebugParams {
  t: number | null;
  sun: SunSetting | null;
  pose: CameraPose | null;
  viewerOpen: boolean;
  /** People and traffic (see `LifeMode`). "still" from a link shows the
   * scene's starting state, which is the same every time — so a shared
   * link reproduces the same picture, walkers and cars included. */
  life: LifeMode | null;
  /** `?perf=1`: show the performance readout (ui/PerfPanel.tsx). */
  perf: boolean;
  /** Night lighting (see builders/streetlights.ts): "cheap" (default) gives
   * the streetlights nearest the camera a real light and all the others a
   * simplified one (three/lampLighting.ts); `?lights=all` a real light to
   * every streetlight, as before — for comparison. */
  nightLights: "cheap" | "all";
  /** `?realLights=N`: how many streetlights near what's in view get a real,
   * shadow-casting light (default 8) — for testing. */
  realLights: number | null;
}

function num(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function readDebugParams(search: string = window.location.search): DebugParams {
  const params = new URLSearchParams(search);

  const month = num(params, "month");
  const day = num(params, "day");
  const hour = num(params, "hour");
  const sun = month !== null && day !== null && hour !== null ? { month, day, hour } : null;

  const lng = num(params, "lng");
  const lat = num(params, "lat");
  const eyeHeight = num(params, "eyeHeight");
  const bearingDeg = num(params, "bearing");
  const pitchDeg = num(params, "pitch");
  const pose =
    lng !== null && lat !== null && eyeHeight !== null && bearingDeg !== null && pitchDeg !== null
      ? { lng, lat, eyeHeight, bearingDeg, pitchDeg, fovDeg: num(params, "fov") ?? DEFAULT_FOV_DEG }
      : null;

  return {
    t: num(params, "t"),
    sun,
    pose,
    viewerOpen: params.get("viewer") === "1" || pose !== null,
    life: LIFE_MODES.find((mode) => mode === params.get("life")) ?? null,
    perf: params.get("perf") === "1",
    nightLights: params.get("lights") === "all" ? "all" : "cheap",
    realLights: num(params, "realLights"),
  };
}

/** Inverse of `readDebugParams`, used by the "Copia URL vista" button. */
export function buildDebugUrl(state: { t: number; sun: SunSetting; pose: CameraPose | null; life: LifeMode }): string {
  const params = new URLSearchParams();
  params.set("viewer", "1");
  params.set("t", String(state.t));
  params.set("month", String(state.sun.month));
  params.set("day", String(state.sun.day));
  params.set("hour", String(state.sun.hour));
  if (state.pose) {
    params.set("lng", String(state.pose.lng));
    params.set("lat", String(state.pose.lat));
    params.set("eyeHeight", String(state.pose.eyeHeight));
    params.set("bearing", String(state.pose.bearingDeg));
    params.set("pitch", String(state.pose.pitchDeg));
    params.set("fov", String(state.pose.fovDeg));
  }
  params.set("life", state.life);
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}
