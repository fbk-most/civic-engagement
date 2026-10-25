/** The core frontend, as a domain pack's app uses it. */
import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { AccessGate } from "./AccessGate";
import { registerPack, type FrontendPack } from "./pack";

export type { FrontendPack, Pair } from "./pack";
export type { MapElementLayer, MapLayerHelpers } from "./map/layers";
export type { IconShape } from "./ui/cardIconShapes";
export type { ExpressionSpecification } from "maplibre-gl";

/** Renders the app for `pack` into `root`. */
export function startApp(pack: FrontendPack, root: HTMLElement): void {
  registerPack(pack);
  createRoot(root).render(createElement(StrictMode, null, createElement(AccessGate)));
}

// For the packs' own scene parts (FrontendPack.scene3d.parts).
export type { DiscreteElement, CoverPolygon } from "./api/types";
export type { PartBuilder, PartInputs, ScenePart } from "./three/parts";
export { MaterialLibrary, type Surface } from "./three/materials";
export { instanced } from "./three/instancing";
export { toLocal, type GeoAnchor } from "./three/geo";
export { FLAT_TERRAIN, type Terrain } from "./three/terrain";
export type { ForestTree, TreeKind, TreeSource } from "./three/builders/forest";
export { polygonRings } from "./three/geo";
export { elementYaw } from "./three/hash";
export { daylightFraction, type SunPosition } from "./three/sun";
export { setLampIntensity, setLampLayout, setRealLamps } from "./three/lampLighting";
export { readDebugParams } from "./debugParams";
