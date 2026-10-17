/** Turns a `SceneResponse` into a three.js object graph.
 *
 * Rebuilt wholesale on every scene change rather than diffed, matching the
 * stance `map/layers.ts` already takes for the MapLibre sources — that
 * removes a whole class of "the 3D view drifted out of sync with the model"
 * bugs. It was cheap enough (a few milliseconds) for that tradeoff to be a
 * clear win when this was written; procedural tree density has since made
 * vegetation alone ~1-1.5s of it (see `builders/vegetation.ts`,
 * `builders/branches.ts`) — which is why the trees, alone, are not rebuilt
 * wholesale: unchanged ones are reused across scenes (see `TreeChunk`),
 * and a date change rebuilds nothing (see `applySeason`). Worth knowing
 * before reaching for "just rebuild everything" again elsewhere in this
 * file.
 */

import * as THREE from "three";
import { Water } from "three/examples/jsm/objects/Water.js";
import type { DiscreteElement, SceneResponse } from "../api/types";
import { buildGround } from "./builders/ground";
import { buildPaths } from "./builders/paths";
import { buildVegetation } from "./builders/vegetation";
import { buildWater } from "./builders/water";
import { ACTIVE_PROVIDER } from "./builders/buildings";
import { anchorFromPolygon, localBounds, polygonRings, toLocal, type GeoAnchor } from "./geo";
import { MaterialLibrary } from "./materials";
import type { ScenePart } from "./parts";
import { activePack } from "../pack";
import type { SeasonState } from "./sun";
import type { Footprint } from "./walk";

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
  /** The parts that follow the sun, the frames or the camera (the water,
   * the pack's streetlights...): `Viewer` calls their hooks, rather than
   * rebuilding them on every sun change. */
  parts: ScenePart[];
  /** Shows the trees as in `season` (leaf density, autumn tint): the scene
   * itself doesn't depend on the date, so a date change needs no rebuild. */
  applySeason: (season: SeasonState) => void;
  /** Lets go of what the scene shares with others (the tree chunks, see
   * builders/vegetation.ts): call `disposeScene`, not this. */
  release: () => void;
}

/** Disposes every geometry under a subtree — but the shared ones (the tree
 * chunks, released by `disposeScene`). Materials are owned by the
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
    if ((child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh) && !child.userData.sharedGeometry) {
      child.geometry.dispose();
    }
    if (child instanceof Water) {
      child.material.uniforms.mirrorSampler.value?.dispose();
      child.material.dispose();
    }
  });
}

/** Disposes a built scene that's no longer drawn. */
export function disposeScene(built: BuiltScene): void {
  disposeGroup(built.group);
  for (const part of built.parts) part.dispose?.();
  built.release();
}

export async function buildScene(
  scene: SceneResponse,
  materials: MaterialLibrary,
  showInterventions = true
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

  const { scene3d } = activePack();
  group.add(buildGround(covers, anchor, materials));
  // `buildPaths` is generic on `properties.width`/`properties.material`:
  // whatever the pack draws as ribbons (for the urban one, streets,
  // crossing stripes and lane dividers as well as paths) renders through
  // the exact same ribbon-mesh path, no separate builder needed.
  const ribbonTypes = new Set(scene3d.ribbonTypes);
  group.add(buildPaths(elements.filter((e) => ribbonTypes.has(e.type)), anchor, materials));
  group.add(await ACTIVE_PROVIDER.build(buildings, { anchor, materials }));
  const vegetation = await buildVegetation(elements, anchor, materials);
  group.add(vegetation.group);

  const parts: ScenePart[] = [];
  for (const build of scene3d.parts) parts.push(await build({ elements, covers, anchor, materials }));
  parts.push(buildWater(covers, anchor));
  for (const part of parts) group.add(part.object);

  return {
    group,
    anchor,
    bounds: localBounds(anchor, [scene.site_boundary]),
    footprints: buildingFootprints(buildings, anchor),
    parts,
    applySeason: vegetation.applySeason,
    release: vegetation.release,
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
