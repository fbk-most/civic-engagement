import * as THREE from "three";
import type { CoverPolygon } from "../../api/types";
import type { GeoAnchor } from "../geo";
import type { MaterialLibrary } from "../materials";
import { coverHeight, drapeGeometry, flatGeometry } from "../shapes";
import type { Terrain } from "../terrain";
import { activePack } from "../../pack";

/** Ground cover as meshes on the ground, one per cover polygon: flat on a
 * flat site, laid on the terrain otherwise (see shapes.ts's `drapeGeometry`).
 *
 * Cover polygons overlap freely — OSM double-tags ground constantly, and
 * `bologna_civic_dt/layout.py` deliberately layers intervention covers on top of the
 * baseline rather than clipping them in. So draw order matters, and it is
 * taken from the list order: a cover later in the list sits above an earlier
 * one. That is the same precedence the space-use indicator applies, which
 * means the pond you see over the lawn is also the pond the percentages
 * counted as pond rather than lawn.
 */
export function buildGround(
  covers: CoverPolygon[],
  anchor: GeoAnchor,
  materials: MaterialLibrary,
  terrain: Terrain
): THREE.Group {
  const group = new THREE.Group();
  group.name = "ground";

  const waterTypes = new Set(activePack().scene3d.waterCoverTypes);
  for (const [index, cover] of covers.entries()) {
    // Ponds get a real animated Water surface instead — see builders/water.ts,
    // wired in by SceneBuilder alongside this group.
    if (waterTypes.has(cover.cover_type)) continue;

    const lift = coverHeight(index, covers.length);
    const flat = flatGeometry(anchor, cover.geometry, terrain.flat ? lift : 0);
    if (!flat) continue;
    const geometry = terrain.flat ? flat : drapeGeometry(flat, terrain, lift);

    const mesh = new THREE.Mesh(geometry, materials.cover(cover.cover_type));
    // The ground never casts (it is the bottom of the world) but must receive,
    // or tree and building shadows have nothing to land on.
    mesh.receiveShadow = true;
    mesh.name = cover.id;
    group.add(mesh);
  }

  return group;
}
