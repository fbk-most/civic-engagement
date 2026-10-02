/** The virtual camera the facilitator places on the map.
 *
 * A camera is a *view*, not an intervention: it never enters the model, is
 * never sent to the backend, and placing one changes nothing about the
 * proposal. That distinction matters in a workshop — "I moved the camera" and
 * "I planted a tree" must never look like the same kind of act.
 */

import { directionToBearing, toLocal, toLngLat, type GeoAnchor } from "./geo";

/** Eye height of a standing adult. The whole point of the placed camera is to
 * show the square as a person in it would see it, so this is not adjustable
 * without a reason. */
export const EYE_HEIGHT_M = 1.65;

export const DEFAULT_FOV_DEG = 60;

/** Vertical field of view of the 3D overview and of the 2D map (see
 * map/viewSync.ts): the same angle in both, so a framing carried from one
 * to the other shows the same piece of the square. */
export const OVERVIEW_FOV_DEG = 55;

/** Hard floor for the camera, in metres.
 *
 * Comfortably above the ground stack — cover polygons occupy y up to 0.06 m
 * and path ribbons sit at 0.08 m — so the camera can get low without the
 * pavement clipping through the near plane. Dropping below ground gives a view
 * of the underside of the world, which in a citizen workshop just looks like
 * the tool is broken.
 */
export const MIN_CAMERA_HEIGHT_M = 0.5;

/** How far ahead the view is aimed when the pose is applied. */
export const LOOK_DISTANCE_M = 25;

export interface CameraPose {
  lng: number;
  lat: number;
  eyeHeight: number;
  /** Compass bearing the camera looks along (0 = north, 90 = east). */
  bearingDeg: number;
  /** Positive looks up. Placed cameras start level. */
  pitchDeg: number;
  fovDeg: number;
}

/** Builds a pose from the two map clicks: where the viewer stands, and a point
 * they look towards. */
export function poseFromPoints(
  anchor: GeoAnchor,
  from: [number, number],
  to: [number, number]
): CameraPose {
  const [fx, fz] = toLocal(anchor, from[0], from[1]);
  const [tx, tz] = toLocal(anchor, to[0], to[1]);

  return {
    lng: from[0],
    lat: from[1],
    eyeHeight: EYE_HEIGHT_M,
    bearingDeg: directionToBearing(tx - fx, tz - fz),
    pitchDeg: 0,
    fovDeg: DEFAULT_FOV_DEG,
  };
}

/** The camera's field of view as a map polygon, so the facilitator can see on
 * the plan what the 3D panel is showing. Drawn as a sector: apex at the
 * camera, opening `fovDeg` wide along the bearing. */
export function frustumWedge(
  anchor: GeoAnchor,
  pose: CameraPose,
  lengthM = 45,
  segments = 12
): GeoJSON.Polygon {
  const [cx, cz] = toLocal(anchor, pose.lng, pose.lat);
  const half = (pose.fovDeg / 2) * (Math.PI / 180);
  const bearing = pose.bearingDeg * (Math.PI / 180);

  const ring: GeoJSON.Position[] = [[pose.lng, pose.lat]];
  for (let i = 0; i <= segments; i++) {
    const angle = bearing - half + (2 * half * i) / segments;
    // Same convention as `bearingToDirection`: north is -Z, east is +X.
    const x = cx + Math.sin(angle) * lengthM;
    const z = cz - Math.cos(angle) * lengthM;
    ring.push(toLngLat(anchor, x, z));
  }
  ring.push([pose.lng, pose.lat]);

  return { type: "Polygon", coordinates: [ring] };
}
