import type * as THREE from "three";
import type { CoverPolygon, DiscreteElement } from "../api/types";
import type { GeoAnchor } from "./geo";
import type { MaterialLibrary } from "./materials";
import type { SunPosition } from "./sun";

/** One part of the 3D scene (the water, the pack's furniture or
 * streetlights...), with what it needs to follow the sun and the camera —
 * which the viewer calls, without knowing what the part is. */
export interface ScenePart {
  object: THREE.Object3D;
  /** After the build and on every sun change. */
  setSun?: (sun: SunPosition, materials: MaterialLibrary) => void;
  /** Every frame. */
  frame?: (camera: THREE.Camera, elapsedS: number) => void;
  /** After the build and when the camera has moved or turned enough — at
   * most twice a second (see Viewer.tsx's `updateShadowCasters`). */
  cameraMoved?: (camera: THREE.Camera) => void;
  /** Frees what disposing the object's geometries doesn't (see
   * SceneBuilder.ts's `disposeGroup`). */
  dispose?: () => void;
}

export interface PartInputs {
  elements: DiscreteElement[];
  covers: CoverPolygon[];
  anchor: GeoAnchor;
  materials: MaterialLibrary;
}

/** Builds a part of the scene: the pack's own (`FrontendPack.scene3d`). */
export type PartBuilder = (inputs: PartInputs) => ScenePart | Promise<ScenePart>;
