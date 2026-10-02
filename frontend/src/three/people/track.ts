/** A route as a polyline shifted sideways (to the right of the direction of
 * travel), with cumulative distances for sampling a position at a given
 * distance along it. Shared by walkers (keeping right on a path) and cars
 * (driving in their lane). */

type Point = [number, number];

export class Track {
  readonly points: Point[];
  readonly distances: number[];
  readonly length: number;

  /** `right`: how far right of the centre line to keep — one value for the
   * whole route, or one per point (a car's lane offset differs between a
   * one-way and a two-way street). */
  constructor(route: Point[], right: number | number[]) {
    this.points = route.map((point, i) => {
      const offset = typeof right === "number" ? right : right[i];
      // Average the directions of the segments either side of the vertex;
      // the right-hand side is (dz, -dx) for a direction (dx, dz).
      const prev = route[Math.max(0, i - 1)];
      const next = route[Math.min(route.length - 1, i + 1)];
      let dx = next[0] - prev[0];
      let dz = next[1] - prev[1];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      return [point[0] + dz * offset, point[1] - dx * offset];
    });
    this.distances = [0];
    for (let i = 1; i < this.points.length; i++) {
      const [ax, az] = this.points[i - 1];
      const [bx, bz] = this.points[i];
      this.distances.push(this.distances[i - 1] + Math.hypot(bx - ax, bz - az));
    }
    this.length = this.distances[this.distances.length - 1];
  }

  /** Position and direction of travel at distance `s`. */
  sample(s: number, out: { x: number; z: number; heading: number }): void {
    let i = 1;
    while (i < this.points.length - 1 && this.distances[i] < s) i++;
    const [ax, az] = this.points[i - 1];
    const [bx, bz] = this.points[i];
    const span = this.distances[i] - this.distances[i - 1] || 1;
    const f = Math.max(0, Math.min(1, (s - this.distances[i - 1]) / span));
    out.x = ax + (bx - ax) * f;
    out.z = az + (bz - az) * f;
    out.heading = Math.atan2(bx - ax, bz - az);
  }

  /** Distance along the track of the point nearest to `p`, and how far
   * from the track that point is. */
  project(p: Point): { s: number; distance: number } {
    let best = { s: 0, distance: Infinity };
    for (let i = 1; i < this.points.length; i++) {
      const [ax, az] = this.points[i - 1];
      const [bx, bz] = this.points[i];
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / len2));
      const distance = Math.hypot(ax + dx * t - p[0], az + dz * t - p[1]);
      if (distance < best.distance) best = { s: this.distances[i - 1] + Math.sqrt(len2) * t, distance };
    }
    return best;
  }
}
