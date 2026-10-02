/** Turns a `SceneResponse` into a three.js object graph.
 *
 * Rebuilt wholesale on every scene change rather than diffed, matching the
 * stance `map/layers.ts` already takes for the MapLibre sources — that
 * removes a whole class of "the 3D view drifted out of sync with the model"
 * bugs. It was cheap enough (a few milliseconds) for that tradeoff to be a
 * clear win when this was written; procedural tree density has since made
 * vegetation alone ~1-1.5s of it (see `builders/vegetation.ts`,
 * `builders/branches.ts`), which now fires on every scenario-year *and*
 * every month/date change (see `SeasonState`) — worth knowing before
 * reaching for "just rebuild everything" again elsewhere in this file.
 */

import * as THREE from "three";
import { Water } from "three/examples/jsm/objects/Water.js";
import type { DiscreteElement, SceneResponse } from "../api/types";
import { buildGround } from "./builders/ground";
import { buildPaths } from "./builders/paths";
import { buildVegetation } from "./builders/vegetation";
import { buildStreetlights, type StreetlightBuild } from "./builders/streetlights";
import { buildWater } from "./builders/water";
import { ACTIVE_PROVIDER } from "./builders/buildings";
import { anchorFromPolygon, localBounds, polygonRings, toLocal, type GeoAnchor } from "./geo";
import { MaterialLibrary } from "./materials";
import type { SeasonState } from "./sun";
import type { Footprint } from "./walk";

const FULL_LEAF_SEASON: SeasonState = { leafDensity: 1, autumnMix: 0 };

export interface BuiltScene {
  group: THREE.Group;
  anchor: GeoAnchor;
  /** Local-frame XZ extent of the site boundary, used to fit the shadow camera
   * and to clamp the walk-mode camera. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Building outlines in the local frame, for walk-mode collision. Outer
   * rings only — a courtyard you could only reach through a wall isn't worth
   * the extra tests. */
  footprints: Footprint[];
  /** The streetlights' live lights, toggled by `Viewer` based on the sun's
   * altitude rather than rebuilt on every sun change. */
  streetlights: StreetlightBuild;
  /** One per pond, updated every frame (camera position, elapsed time) and
   * on every sun change (direction/colour) — see Viewer.tsx. */
  waterSurfaces: Water[];
}

/** Disposes every geometry under a subtree. Materials are owned by the
 * MaterialLibrary and outlive individual rebuilds, so they're left alone —
 * except `Water` (see builders/water.ts), which builds itself a private
 * `ShaderMaterial` and its own reflection render target rather than sharing
 * anything from the library, and would otherwise leak GPU resources on every
 * scene rebuild. (Water.js exposes the render target's *texture* via the
 * `mirrorSampler` uniform but never the render target/framebuffer itself, so
 * this can only dispose that texture, not the framebuffer object behind
 * it — a small, bounded leak per rebuild inherent to that addon, not fixable
 * from outside it short of vendoring a patched copy.) */
export function disposeGroup(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh) {
      child.geometry.dispose();
    }
    if (child instanceof Water) {
      child.material.uniforms.mirrorSampler.value?.dispose();
      child.material.dispose();
    }
  });
}

export async function buildScene(
  scene: SceneResponse,
  materials: MaterialLibrary,
  showInterventions = true,
  season: SeasonState = FULL_LEAF_SEASON
): Promise<BuiltScene> {
  const elements = showInterventions
    ? scene.elements
    : scene.elements.filter((element) => element.source === "baseline");
  const covers = showInterventions
    ? scene.covers
    : scene.covers.filter((cover) => cover.source === "baseline");

  // Textures must be in hand before the first material is created: materials
  // are cached on first use, so a map arriving later never reaches them.
  await materials.ensureTextures();

  const anchor = anchorFromPolygon(scene.site_boundary);
  const buildings = elements.filter((e) => e.type === "building");
  const group = new THREE.Group();
  group.name = "civic-scene";

  group.add(buildGround(covers, anchor, materials));
  // `buildPaths` is generic on `properties.width`/`properties.material` —
  // streets, crossing stripes and lane dividers are all just LineString/
  // MultiLineString elements with their own `material` (see
  // ingestion/build_baseline.py), so they render through the exact same
  // ribbon-mesh path as pedestrian paths, no separate builder needed.
  group.add(
    buildPaths(
      elements.filter(
        (e) => e.type === "path" || e.type === "street" || e.type === "crossing" || e.type === "lane_divider"
      ),
      anchor,
      materials
    )
  );
  group.add(await ACTIVE_PROVIDER.build(buildings, { anchor, materials }));
  group.add(await buildVegetation(elements, anchor, materials, season));

  const streetlights = buildStreetlights(elements, anchor, materials);
  if (streetlights.poleMesh) group.add(streetlights.poleMesh);
  if (streetlights.globeMesh) group.add(streetlights.globeMesh);
  for (const light of streetlights.lights) group.add(light);

  const { group: waterGroup, surfaces: waterSurfaces } = buildWater(covers, anchor);
  group.add(waterGroup);

  return {
    group,
    anchor,
    bounds: localBounds(anchor, [scene.site_boundary]),
    footprints: buildingFootprints(buildings, anchor),
    streetlights,
    waterSurfaces,
  };
}

export function buildingFootprints(buildings: DiscreteElement[], anchor: GeoAnchor): Footprint[] {
  const footprints: Footprint[] = [];
  for (const building of buildings) {
    for (const rings of polygonRings(building.geometry)) {
      const flat: number[] = [];
      for (const [lng, lat] of rings[0]) {
        const [x, z] = toLocal(anchor, lng, lat);
        flat.push(x, z);
      }
      if (flat.length >= 6) footprints.push(flat);
    }
  }
  return footprints;
}
