import { readDebugParams } from "../debugParams";
import { activePack } from "../pack";
import type { LifeMode } from "./people/activity";
import type { TreeWorkerPool } from "./workers/treeWorkerPool";

/** How heavy one 3D view is drawn: the same code draws the single view and
 * the two side by side of a comparison, with different settings. */
export interface View3DSettings {
  /** How many streetlights near what's in view get a real, shadow-casting
   * light; null: the pack's own choice (its streetlights part). */
  realLights: number | null;
  /** How fine the trees stay with distance (see treeLod.ts): 1 is the
   * normal detail, 0.5 lighter, up to 4. */
  treeDetail: number;
  /** People and traffic when the view opens; null: as the view has them
   * by default (moving). */
  life: LifeMode | null;
}

/** What a scene's builders get about the view they build for: its
 * settings, and its own pool of tree workers. */
export interface ViewContext {
  settings: View3DSettings;
  trees: TreeWorkerPool;
}

/** Comparing two scenarios side by side, unless the pack says otherwise
 * (`FrontendPack.scene3d.split`). Measured on a Radeon 860M laptop, two
 * views side by side (2026-11-28): each at about half the single view's
 * frame rate, the cost being the geometry drawn again for every shadow,
 * not the pixels; one real streetlight instead of eight took the night from
 * 12 to 25 fps each, lighter trees the day from 24 to 27, people and traffic
 * off about a quarter more. */
export const SPLIT_DEFAULTS: View3DSettings = { realLights: 1, treeDetail: 0.5, life: "off" };

/** The settings of a view: the single one's, or one of a split's — the
 * URL's testing parameters (`?realLights=`, `?detail=`, `?life=`) first,
 * then the pack's, then the core's. */
export function viewSettings(split: boolean): View3DSettings {
  const url = readDebugParams();
  const base: View3DSettings = split
    ? { ...SPLIT_DEFAULTS, ...activePack().scene3d.split }
    : { realLights: null, treeDetail: 1, life: null };
  return {
    realLights: url.realLights ?? base.realLights,
    treeDetail: Math.min(4, Math.max(0.5, url.detail ?? base.treeDetail)),
    life: url.life ?? base.life,
  };
}
