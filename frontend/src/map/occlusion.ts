/** Approximates whether a ground-level marker (tree, bench, streetlight, ...)
 * is hidden behind a building, from the 2D map's current camera angle.
 *
 * MapLibre's own renderer can't answer this for us. `fill-extrusion`
 * (buildings) and `circle` (markers) layers only get a real depth test
 * against each other when the circle layer is declared *before* the first 3D
 * layer in the style stack — see `painter.ts`'s `opaquePassEnabledForLayer`/
 * `getDepthModeForSublayer`: any layer at or after that point renders with
 * `DepthMode.disabled`, pure painter's-algorithm, by design ("layers drawn
 * above 3D layers need to appear above 3D features"). Our point layers are
 * declared after `buildings-extrusion` in `layers.ts`, so they always draw on
 * top, solid walls or not — this has nothing to do with the wall's opacity.
 * Reordering wouldn't fix it either: the depth value a 2D layer gets even
 * when it *is* eligible is a synthetic per-layer slice (`1 - layerIndex *
 * epsilon`), not the marker's real distance from the camera, so there's
 * nothing meaningful to compare it against a building's true depth with.
 *
 * So this does the comparison by hand: for each marker, walk the straight
 * line from the camera to the marker's ground position, find where that line
 * is at each building's roof height, and check whether that crossing point
 * falls inside the building's footprint. If it does, the wall is physically
 * between the camera and the marker, and we dim the marker instead of hiding
 * it outright — a hint that something is there, not a disappearance.
 *
 * Building footprints are treated as their outer ring only (no holes) — real
 * courtyards would make a marker glimpsed "through" one register as occluded
 * instead of visible, which is a conservative miss, not a wrong-direction one.
 */

import { MercatorCoordinate, type MapLibreMap } from "maplibre-gl";
import type { DiscreteElement } from "../api/types";
import { polygonRings, toLocal, type GeoAnchor } from "../three/geo";

// MapLibre's fixed vertical field of view, in radians — the constant behind
// `Transform`'s `cameraToCenterDistance` (see `transform_helper.ts`). The
// camera's real-world position isn't exposed on the public `Map` API (only
// on the internal `_camera.transform`), so we rebuild it here from public
// state (`getCenter`/`getZoom`/`getPitch`/`getBearing`) instead of reaching
// into a private field. This app never calls `setFov`, so the default always
// applies.
const CAMERA_FOV_RADIANS = 0.6435011087932844;

// How transparent an occluded marker becomes. Not zero: this is meant to
// read as "something is behind that wall," not to disappear the same way
// hiding it outright would.
const OCCLUDED_OPACITY = 0.25;

interface LocalPoint {
  x: number;
  z: number;
}

function cameraDirectionFromPitchBearing(pitchRad: number, bearingRad: number): LocalPoint & { y: number } {
  const h = Math.sin(pitchRad);
  return {
    x: h * Math.sin(bearingRad),
    y: -h * Math.cos(bearingRad),
    z: Math.cos(pitchRad),
  };
}

/** Camera position in the same local metre frame as everything else in this
 * app (see `three/geo.ts`), derived the same way MapLibre derives it
 * internally, just from public `Map` getters instead of the private
 * transform. Two separate borrowed formulas, not one: lng/lat comes from
 * `mercator_utils.ts`'s `cameraMercatorCoordinateFromCenterAndRotation`
 * (the same helper behind the real `getCameraLngLat()`), but that helper's
 * `z` is *not* a usable altitude — round-tripping it through
 * `MercatorCoordinate.toAltitude()` gives nonsense (verified empirically:
 * large negative numbers at ordinary pitch/zoom). The real `getCameraAltitude()`
 * doesn't go through that `z` either; it uses a direct, unrelated trig
 * formula (`transform_helper.ts`), reproduced below. */
function cameraLocalPosition(map: MapLibreMap, anchor: GeoAnchor): LocalPoint & { altitude: number } {
  const centerMerc = MercatorCoordinate.fromLngLat(map.getCenter(), 0);
  const metersToMerc = centerMerc.meterInMercatorCoordinateUnits();
  const worldSizePx = 512 * Math.pow(2, map.getZoom());
  const pixelPerMeter = metersToMerc * worldSizePx;
  const distancePx = (0.5 / Math.tan(CAMERA_FOV_RADIANS / 2)) * (map.getContainer().clientHeight || 1);
  const distanceM = distancePx / pixelPerMeter;

  const pitchRad = (map.getPitch() * Math.PI) / 180;
  const bearingRad = (map.getBearing() * Math.PI) / 180;
  const dir = cameraDirectionFromPitchBearing(pitchRad, bearingRad);
  const dMerc = distanceM * metersToMerc;

  const camMerc = new MercatorCoordinate(centerMerc.x - dMerc * dir.x, centerMerc.y - dMerc * dir.y);
  const camLngLat = camMerc.toLngLat();
  const [x, z] = toLocal(anchor, camLngLat.lng, camLngLat.lat);
  const altitude = distanceM * Math.cos(pitchRad);
  return { x, z, altitude };
}

/** Standard ray-casting point-in-polygon test; `ring` need not be closed. */
function pointInRing(p: LocalPoint, ring: LocalPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const crosses = a.z > p.z !== b.z > p.z;
    if (crosses && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(p1: LocalPoint, p2: LocalPoint, p3: LocalPoint, p4: LocalPoint): boolean {
  const d = (p2.x - p1.x) * (p4.z - p3.z) - (p2.z - p1.z) * (p4.x - p3.x);
  if (d === 0) return false; // parallel or collinear — not worth resolving for a footprint edge
  const t = ((p3.x - p1.x) * (p4.z - p3.z) - (p3.z - p1.z) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.z - p1.z) - (p3.z - p1.z) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function segmentEntersRing(segStart: LocalPoint, segEnd: LocalPoint, ring: LocalPoint[]): boolean {
  if (pointInRing(segEnd, ring) || pointInRing(segStart, ring)) return true;
  for (let i = 0; i < ring.length - 1; i++) {
    if (segmentsIntersect(segStart, segEnd, ring[i], ring[i + 1])) return true;
  }
  return false;
}

interface BuildingFootprint {
  heightM: number;
  outerRings: LocalPoint[][];
}

function buildingFootprint(anchor: GeoAnchor, building: DiscreteElement): BuildingFootprint {
  const heightM = typeof building.properties.height === "number" ? building.properties.height : 10;
  const outerRings = polygonRings(building.geometry).map((rings) =>
    rings[0].map(([lng, lat]) => {
      const [x, z] = toLocal(anchor, lng, lat);
      return { x, z };
    })
  );
  return { heightM, outerRings };
}

/** Is `marker` behind `building` as seen from `camera`? Walks the segment
 * from camera to marker, restricted to the portion where its height is
 * within the building's [0, heightM] band (the camera is above that band and
 * the marker is on the ground, so that band is always a single contiguous
 * sub-segment ending at the marker), and checks whether that sub-segment
 * enters the footprint. */
function isOccludedByBuilding(
  marker: LocalPoint,
  camera: LocalPoint & { altitude: number },
  building: BuildingFootprint
): boolean {
  if (camera.altitude <= 0.01) return false; // degenerate camera pose, nothing meaningful to test
  const bandStartT = Math.min(1, Math.max(0, 1 - building.heightM / camera.altitude));
  const bandStart: LocalPoint = {
    x: camera.x + bandStartT * (marker.x - camera.x),
    z: camera.z + bandStartT * (marker.z - camera.z),
  };
  return building.outerRings.some((ring) => segmentEntersRing(bandStart, marker, ring));
}

interface OcclusionState {
  anchor: GeoAnchor;
  buildings: DiscreteElement[];
  markersBySource: Map<string, DiscreteElement[]>;
}

const stateByMap = new WeakMap<MapLibreMap, OcclusionState>();

/** Re-evaluates occlusion for every tracked marker against the current
 * camera pose and pushes the result into each feature's `occluded` state —
 * the paint expressions in `layers.ts` read that state to dim occluded
 * markers. Safe to call often (e.g. on every `moveend`): cost is
 * `markers x buildings`, trivially small at this scene's scale. No-op until
 * `setOcclusionInputs` has run at least once for this map. */
export function refreshOcclusion(map: MapLibreMap): void {
  const state = stateByMap.get(map);
  if (!state) return;
  const camera = cameraLocalPosition(map, state.anchor);
  const footprints = state.buildings.map((b) => buildingFootprint(state.anchor, b));
  for (const [source, markers] of state.markersBySource) {
    for (const marker of markers) {
      if (marker.geometry.type !== "Point") continue;
      const [lng, lat] = marker.geometry.coordinates;
      const [x, z] = toLocal(state.anchor, lng, lat);
      const occluded = footprints.some((building) => isOccludedByBuilding({ x, z }, camera, building));
      map.setFeatureState({ source, id: marker.id }, { occluded });
    }
  }
  // `setFeatureState` normally schedules its own repaint, but this can also
  // run outside the usual move/data-change paths that already guarantee one
  // (see call sites) — cheap enough to force explicitly rather than risk a
  // stale frame.
  map.triggerRepaint();
}

/** Records which elements occlusion should track for `map` and immediately
 * re-evaluates them. Call once per `renderScene` — cheap relative to the
 * rest of that rebuild, and keeps `refreshOcclusion` (called from a
 * `moveend` listener set up once at first render) working off current data
 * without needing the full scene passed to it again on every camera move. */
export function setOcclusionInputs(
  map: MapLibreMap,
  anchor: GeoAnchor,
  buildings: DiscreteElement[],
  markersBySource: Record<string, DiscreteElement[]>
): void {
  stateByMap.set(map, { anchor, buildings, markersBySource: new Map(Object.entries(markersBySource)) });
  refreshOcclusion(map);
}

export { OCCLUDED_OPACITY };
