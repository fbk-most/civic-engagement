/** Conversion between WGS84 lng/lat and the local metric frame the 3D scene
 * lives in.
 *
 * The frame is a tangent plane anchored at the site centroid: X points east,
 * Y points up, Z points south (so compass north is -Z, which is where a
 * three.js camera with bearing 0 looks by default). Units are metres.
 *
 * The conversion is a plain equirectangular scaling rather than a real UTM
 * projection like `civic_engagement/geo_utils.py` uses. Over a ~350 m site the
 * difference is well under a centimetre, and doing it this way keeps the
 * frontend free of a projection dependency. If the tool ever covers more than
 * a few city blocks, swap this for a proper transform — every caller goes
 * through `toLocal`/`toLngLat`, so the change stays contained here.
 */

export interface GeoAnchor {
  lng0: number;
  lat0: number;
  metersPerLng: number;
  metersPerLat: number;
}

/** Metres per degree at a given latitude (standard WGS84 series approximation). */
function metersPerDegree(latDeg: number): { perLng: number; perLat: number } {
  const phi = (latDeg * Math.PI) / 180;
  return {
    perLat: 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi),
    perLng: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi),
  };
}

export function anchorFromPolygon(polygon: GeoJSON.Polygon): GeoAnchor {
  const ring = polygon.coordinates[0];
  let lngSum = 0;
  let latSum = 0;
  for (const [lng, lat] of ring) {
    lngSum += lng;
    latSum += lat;
  }
  const lng0 = lngSum / ring.length;
  const lat0 = latSum / ring.length;
  const { perLng, perLat } = metersPerDegree(lat0);
  return { lng0, lat0, metersPerLng: perLng, metersPerLat: perLat };
}

/** lng/lat -> local [x, z] in metres. Y (up) is always supplied by the caller. */
export function toLocal(anchor: GeoAnchor, lng: number, lat: number): [number, number] {
  return [
    (lng - anchor.lng0) * anchor.metersPerLng,
    -(lat - anchor.lat0) * anchor.metersPerLat,
  ];
}

export function toLngLat(anchor: GeoAnchor, x: number, z: number): [number, number] {
  return [
    anchor.lng0 + x / anchor.metersPerLng,
    anchor.lat0 - z / anchor.metersPerLat,
  ];
}

/** Compass bearing in degrees (0 = north, 90 = east) -> unit direction in the
 * local frame. North is -Z, east is +X. */
export function bearingToDirection(bearingDeg: number): [number, number] {
  const rad = (bearingDeg * Math.PI) / 180;
  return [Math.sin(rad), -Math.cos(rad)];
}

/** Local frame direction -> compass bearing in degrees. */
export function directionToBearing(x: number, z: number): number {
  const deg = (Math.atan2(x, -z) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Every ring of a GeoJSON Polygon or MultiPolygon, as flat ring arrays.
 * Emitted as one group per polygon: `[outer, ...holes]`. */
export function polygonRings(geometry: GeoJSON.Geometry): GeoJSON.Position[][][] {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

/** Local-frame XZ bounding box of a set of lng/lat rings. */
export function localBounds(
  anchor: GeoAnchor,
  geometries: GeoJSON.Geometry[]
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const geometry of geometries) {
    for (const rings of polygonRings(geometry)) {
      for (const [lng, lat] of rings[0]) {
        const [x, z] = toLocal(anchor, lng, lat);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    }
  }
  return { minX, maxX, minZ, maxZ };
}

/** A single point to plant a marker at, for geometries that aren't already a
 * point (line midpoint / polygon centroid, by plain coordinate averaging —
 * this is a marker, not an indicator, so shapely-level precision isn't
 * needed). */
export function representativePoint(geometry: GeoJSON.Geometry): [number, number] {
  const average = (coords: GeoJSON.Position[]): [number, number] => {
    const [sx, sy] = coords.reduce(([ax, ay], [x, y]) => [ax + x, ay + y], [0, 0]);
    return [sx / coords.length, sy / coords.length];
  };
  if (geometry.type === "Point") return geometry.coordinates as [number, number];
  if (geometry.type === "LineString") return average(geometry.coordinates);
  if (geometry.type === "Polygon") return average(geometry.coordinates[0].slice(0, -1));
  if (geometry.type === "MultiPolygon") return average(geometry.coordinates[0][0].slice(0, -1));
  return [0, 0];
}
