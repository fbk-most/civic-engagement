import { MapLibreMap, type StyleSpecification } from "maplibre-gl";
import { OVERVIEW_FOV_DEG } from "../three/camera";

// Approximate centroid of the Piazza Dante site boundary (civic_twin/config.py).
// The camera re-fits to the real boundary once the baseline scene loads.
export const DEFAULT_CENTER: [number, number] = [11.1205, 46.0712];

// Deliberately no external hosted basemap/terrain source: realistic rendering is
// out of scope for this PoC, our own extruded geometry is the whole scene, and
// this keeps the tool free of any venue-internet dependency.
const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#eef2f5" } },
  ],
};

/** `interactive3d: false` gives a flat, north-up plan that can only be panned
 * and zoomed — the 3D view's mini-map, where a tilted or rotated plan would
 * make placing a viewpoint harder, not easier. */
export function createMap(container: HTMLDivElement, { interactive3d = true } = {}): MapLibreMap {
  const map = new MapLibreMap({
    container,
    style: BLANK_STYLE,
    center: DEFAULT_CENTER,
    zoom: 17.5,
    pitch: interactive3d ? 55 : 0,
    bearing: interactive3d ? -20 : 0,
    dragRotate: interactive3d,
    pitchWithRotate: interactive3d,
    touchPitch: interactive3d,
    attributionControl: interactive3d ? undefined : false,
    canvasContextAttributes: { antialias: true },
    // Close to the horizon, like the 3D overview can go (see map/viewSync.ts).
    maxPitch: interactive3d ? 85 : undefined,
  });
  // The 3D overview's angle, so switching tabs keeps the same framing.
  if (interactive3d) map.setVerticalFieldOfView(OVERVIEW_FOV_DEG);
  return map;
}
