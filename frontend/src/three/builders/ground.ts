import * as THREE from "three";
import type { CoverPolygon } from "../../api/types";
import type { GeoAnchor } from "../geo";
import type { MaterialLibrary } from "../materials";
import { coverHeight, flatGeometry } from "../shapes";

/** Ground cover as flat horizontal meshes, one per cover polygon.
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
  materials: MaterialLibrary
): THREE.Group {
  const group = new THREE.Group();
  group.name = "ground";

  for (const [index, cover] of covers.entries()) {
    // Ponds get a real animated Water surface instead — see builders/water.ts,
    // wired in by SceneBuilder alongside this group.
    if (cover.cover_type === "water") continue;

    const geometry = flatGeometry(anchor, cover.geometry, coverHeight(index, covers.length));
    if (!geometry) continue;

    const mesh = new THREE.Mesh(geometry, materials.cover(cover.cover_type));
    // The ground never casts (it is the bottom of the world) but must receive,
    // or tree and building shadows have nothing to land on.
    mesh.receiveShadow = true;
    mesh.name = cover.id;
    group.add(mesh);
  }

  return group;
}
