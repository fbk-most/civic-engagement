// Whether a drawn card lies within the site's boundary: every vertex inside
// it (the backend checks the geometry itself, with a metre's tolerance; see
// civic_engagement/geo_utils.py's within_boundary).

type Position = number[];

export function withinBoundary(geometry: GeoJSON.Geometry, boundary: GeoJSON.Polygon): boolean {
  return vertices(geometry).every((p) => inside(boundary.coordinates, p));
}

function vertices(geometry: GeoJSON.Geometry): Position[] {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates;
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates.flat();
    case "MultiPolygon":
      return geometry.coordinates.flat(2);
    case "GeometryCollection":
      return geometry.geometries.flatMap(vertices);
  }
}

/** Even-odd: the holes are rings too. */
function inside(rings: Position[][], [x, y]: Position): boolean {
  let result = false;
  for (const ring of rings) {
    for (let k = 0, l = ring.length - 1; k < ring.length; l = k++) {
      const [ax, ay] = ring[k];
      const [bx, by] = ring[l];
      if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) result = !result;
    }
  }
  return result;
}
