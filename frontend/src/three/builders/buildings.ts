/** Building geometry, behind a provider seam.
 *
 * The PoC builds buildings by extruding OSM footprints, which is the only
 * option that works fully offline from data we already have. It is also the
 * weakest part of the realism: an extrusion has no roof detail, no balconies
 * and no window reveals.
 *
 * The realistic alternatives — LOD2 solids derived from the Provincia
 * Autonoma di Trento's open LiDAR, or streamed photogrammetry tiles — differ
 * from extrusion only in how the *building* objects get made; ground, paths,
 * vegetation and lighting are unaffected. So they slot in as another
 * `BuildingGeometryProvider` rather than as a rewrite. `ACTIVE_PROVIDER` picks
 * between them; it stays a module constant rather than a UI toggle until
 * there is actually a second implementation to choose.
 */

import * as THREE from "three";
import type { DiscreteElement } from "../../api/types";
import type { GeoAnchor } from "../geo";
import type { MaterialLibrary } from "../materials";
import { geometryToShapes, outlineHeightRange } from "../shapes";
import type { Terrain } from "../terrain";
import { buildRoof } from "./roofs";

export interface SceneContext {
  anchor: GeoAnchor;
  materials: MaterialLibrary;
  terrain: Terrain;
}

export interface BuildingGeometryProvider {
  readonly id: string;
  build(buildings: DiscreteElement[], ctx: SceneContext): Promise<THREE.Object3D>;
}

const DEFAULT_HEIGHT_M = 10;

export const extrusionProvider: BuildingGeometryProvider = {
  id: "osm-extrusion",

  async build(buildings, { anchor, materials, terrain }) {
    const group = new THREE.Group();
    group.name = "buildings";

    for (const building of buildings) {
      const height = Number(building.properties.height ?? DEFAULT_HEIGHT_M);
      const shapes = geometryToShapes(anchor, building.geometry);
      if (shapes.length === 0 || !(height > 0)) continue;

      const geometry = new THREE.ExtrudeGeometry(shapes, {
        depth: height,
        bevelEnabled: false,
      });
      // Extrusion runs along +Z in shape space; this lands it on +Y with the
      // footprint in the XZ plane (see shapes.ts for the sign convention).
      geometry.rotateX(-Math.PI / 2);

      // On a slope, from the lowest ground under its outline: the walls go
      // into the ground uphill rather than float over it downhill.
      const [base] = outlineHeightRange(terrain, anchor, building.geometry);

      const kind = building.properties.building_kind as string | undefined;
      const mesh = new THREE.Mesh(geometry, materials.facade(building.id, kind));
      mesh.position.y = base;
      mesh.castShadow = true;
      // Buildings shade each other across a square this size, so they receive
      // as well as cast — that's most of what makes a facade read as lit.
      mesh.receiveShadow = true;
      mesh.name = building.id;
      group.add(mesh);

      const roofShape = building.properties.roof_shape as string | undefined;
      const ridgeHeightM = building.properties.ridge_height_m as number | undefined;
      const roofColor = building.properties.roof_color as string | undefined;
      const roof = buildRoof(anchor, building.geometry, height, roofShape, ridgeHeightM, materials.roof(roofColor));
      if (roof) {
        roof.position.y += base;
        group.add(roof);
      }
    }

    return group;
  },
};

export const ACTIVE_PROVIDER: BuildingGeometryProvider = extrusionProvider;
