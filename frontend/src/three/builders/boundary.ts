import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { toLocal, type GeoAnchor } from "../geo";
import type { ScenePart } from "../parts";
import type { Terrain } from "../terrain";

// The site's boundary, as in the 2D map (dark grey, dashed; see
// map/layers.ts): a line on the ground, as wide on screen at any distance
// (the overview's 4 km as at eye level), so that what's the site and what's
// its context reads in 3D too. What's in front of it hides it (see the
// TODO, "3D view", for drawing it through the trees but not the hills).

/** Width on screen, pixels. */
const WIDTH_PX = 3;
const COLOR = 0x333333;
/** The dashes, in metres along the line (as the gaps): short enough to
 * read as dashes at eye level, a few metres away. */
const DASH_M = 5;
/** A point at least every this many metres, to follow the ground (the
 * terrain's own surface, see terrain.ts). */
const STEP_M = 2;
/** Above the ground: clear of the ribbons painted on it, low enough not to
 * float. */
const LIFT_M = 0.3;

export function buildBoundary(boundary: GeoJSON.Polygon, anchor: GeoAnchor, terrain: Terrain): ScenePart {
  const positions: number[] = [];
  const ring = boundary.coordinates[0].map(([lng, lat]) => toLocal(anchor, lng, lat));
  for (let k = 1; k < ring.length; k++) {
    const [ax, az] = ring[k - 1];
    const [bx, bz] = ring[k];
    const span = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(span / STEP_M));
    for (let s = k === 1 ? 0 : 1; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps;
      const z = az + ((bz - az) * s) / steps;
      positions.push(x, terrain.heightAt(x, z) + LIFT_M, z);
    }
  }

  const geometry = new LineGeometry();
  geometry.setPositions(positions);
  const material = new LineMaterial({
    color: COLOR,
    linewidth: WIDTH_PX,
    worldUnits: false,
    dashed: true,
    dashSize: DASH_M,
    gapSize: DASH_M,
  });
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  line.name = "site-boundary";
  // Not something to click: and Line2's raycast wants a camera on the raycaster.
  line.raycast = () => {};
  const size = new THREE.Vector2();
  line.onBeforeRender = (renderer) => {
    renderer.getSize(size);
    material.resolution.set(size.x, size.y);
  };
  return { object: line, dispose: () => material.dispose() };
}
