/** Keeping the 2D map and the 3D view on the same framing, so switching tabs
 * doesn't lose where you were looking.
 *
 * The map's camera (centre, zoom, rotation, tilt) and the 3D overview's
 * orbit camera (the point it turns around, distance, direction, angle above
 * the ground) describe the same thing, and both use the same field of view
 * (`OVERVIEW_FOV_DEG`), so a framing converts exactly either way. An
 * eye-level view has no map equivalent — a map seen from 1.65 m shows
 * nothing — so from there the map looks at the same place from above and
 * behind, with the field of view drawn as a wedge.
 *
 * On terrain, the map is still flat: its plane is taken to be the ground at
 * its centre, and a 3D view's height is above the ground under it.
 */

import type { MapLibreMap } from "maplibre-gl";
import type { CameraPose } from "../three/camera";
import { bearingToDirection, toLngLat, toLocal, type GeoAnchor } from "../three/geo";
import { FLAT_TERRAIN, intersectTerrain, type Terrain } from "../three/terrain";

export interface MapFraming {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

// MapLibre's Web Mercator: 512-pixel tiles over the equatorial circumference.
const EARTH_CIRCUMFERENCE_M = 40075016.686;
const TILE_SIZE_PX = 512;
const MAX_MAP_PITCH_DEG = 85;

// Below this height, or not looking down at the ground, a view counts as
// eye level (see the module comment).
const EYE_LEVEL_MAX_HEIGHT_M = 8;
const MIN_LOOK_DOWN_DEG = 90 - MAX_MAP_PITCH_DEG;
// The map for an eye-level view: centred this far ahead of the viewer (so
// both they and what they look at are in the picture), at the map's usual tilt.
const EYE_LEVEL_AHEAD_M = 20;
const EYE_LEVEL_ZOOM = 19;
const EYE_LEVEL_PITCH_DEG = 55;

function metersPerPixel(zoom: number, latDeg: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((latDeg * Math.PI) / 180)) / (TILE_SIZE_PX * 2 ** zoom);
}

/** Camera-to-centre distance, in screen pixels (MapLibre's own relation). */
function cameraToCenterPx(map: MapLibreMap): number {
  const fov = (map.getVerticalFieldOfView() * Math.PI) / 180;
  return (0.5 * map.getCanvas().clientHeight) / Math.tan(fov / 2);
}

export function readMapFraming(map: MapLibreMap): MapFraming {
  const center = map.getCenter();
  return { center: [center.lng, center.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
}

export function sameFraming(a: MapFraming, b: MapFraming): boolean {
  return (
    Math.abs(a.center[0] - b.center[0]) < 1e-7 &&
    Math.abs(a.center[1] - b.center[1]) < 1e-7 &&
    Math.abs(a.zoom - b.zoom) < 0.01 &&
    Math.abs(((a.bearing - b.bearing + 540) % 360) - 180) < 0.1 &&
    Math.abs(a.pitch - b.pitch) < 0.1
  );
}

export function sameView(a: CameraPose, b: CameraPose, anchor: GeoAnchor): boolean {
  const [ax, az] = toLocal(anchor, a.lng, a.lat);
  const [bx, bz] = toLocal(anchor, b.lng, b.lat);
  return (
    Math.hypot(ax - bx, az - bz, a.eyeHeight - b.eyeHeight) < 0.05 &&
    Math.abs(((a.bearingDeg - b.bearingDeg + 540) % 360) - 180) < 0.2 &&
    Math.abs(a.pitchDeg - b.pitchDeg) < 0.2
  );
}

/** Where the map's camera is, as a 3D view: same position, direction and
 * field of view. */
export function mapToView(map: MapLibreMap, anchor: GeoAnchor, terrain: Terrain = FLAT_TERRAIN): CameraPose {
  const { center, zoom, bearing, pitch } = readMapFraming(map);
  const distance = cameraToCenterPx(map) * metersPerPixel(zoom, center[1]);
  const tilt = (pitch * Math.PI) / 180;
  const [tx, tz] = toLocal(anchor, center[0], center[1]);
  const [dx, dz] = bearingToDirection(bearing);
  const back = distance * Math.sin(tilt);
  const [x, z] = [tx - dx * back, tz - dz * back];
  const [lng, lat] = toLngLat(anchor, x, z);
  const above = terrain.heightAt(tx, tz) + distance * Math.cos(tilt) - terrain.heightAt(x, z);
  return {
    lng,
    lat,
    // Downhill of a steep slope, the ground under the camera can be above
    // the map's plane.
    eyeHeight: terrain.flat ? above : Math.max(above, 0.5),
    bearingDeg: (bearing + 360) % 360,
    pitchDeg: pitch - 90,
    fovDeg: map.getVerticalFieldOfView(),
  };
}

/** The map framing for a 3D view, and whether it was an eye-level one (then
 * the caller draws its wedge). */
export function viewToMap(
  map: MapLibreMap,
  anchor: GeoAnchor,
  view: CameraPose,
  terrain: Terrain = FLAT_TERRAIN
): { framing: MapFraming; eyeLevel: boolean } {
  const [x, z] = toLocal(anchor, view.lng, view.lat);
  const [dx, dz] = bearingToDirection(view.bearingDeg);
  const lookDown = -view.pitchDeg;

  if (view.eyeHeight < EYE_LEVEL_MAX_HEIGHT_M || lookDown < MIN_LOOK_DOWN_DEG) {
    const center = toLngLat(anchor, x + dx * EYE_LEVEL_AHEAD_M, z + dz * EYE_LEVEL_AHEAD_M);
    return { framing: { center, zoom: EYE_LEVEL_ZOOM, bearing: view.bearingDeg, pitch: EYE_LEVEL_PITCH_DEG }, eyeLevel: true };
  }

  // The point at the centre of the view, on the ground, is the map's centre.
  const down = (lookDown * Math.PI) / 180;
  let distance = view.eyeHeight / Math.sin(down);
  let ahead = view.eyeHeight / Math.tan(down);
  if (!terrain.flat) {
    const direction = { x: dx * Math.cos(down), y: -Math.sin(down), z: dz * Math.cos(down) };
    const hit = intersectTerrain(terrain, { x, y: terrain.heightAt(x, z) + view.eyeHeight, z }, direction);
    if (hit) {
      distance = hit.distance;
      ahead = hit.distance * Math.cos(down);
    }
  }
  const center = toLngLat(anchor, x + dx * ahead, z + dz * ahead);
  const zoom = Math.log2((cameraToCenterPx(map) * metersPerPixel(0, center[1])) / distance);
  return { framing: { center, zoom, bearing: view.bearingDeg, pitch: 90 - lookDown }, eyeLevel: false };
}
