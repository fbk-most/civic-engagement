import type { MaterialLibrary } from "civic-engagement";

// The urban pack's materials, shared through the core's library like its
// own (see the core's three/materials.ts `shared`).

export function furniture(materials: MaterialLibrary) {
  return materials.shared("furniture", { color: 0x4a4640, roughness: 0.8 });
}

export function waterFeature(materials: MaterialLibrary) {
  return materials.shared("water-feature", { color: 0x3f6f92, roughness: 0.15, metalness: 0.1 });
}

/** Streetlight pole/lamp housing. The actual night-time glow comes from a
 * real `THREE.PointLight` per streetlight (see `streetlights.ts`),
 * not from this material, so it stays a plain dark metal at all hours. */
export function streetlightMetal(materials: MaterialLibrary) {
  return materials.shared("streetlight-metal", { color: 0x2e2e2e, roughness: 0.5, metalness: 0.6 });
}

/** Streetlight globe: frosted glass by day; `applyNightLights` (see
 * `streetlights.ts`) drives its emissive glow after dark. */
export function streetlightGlobe(materials: MaterialLibrary) {
  return materials.shared("streetlight-globe", { color: 0xe8e4da, roughness: 0.35 });
}

/** Traffic signal pole/housing — same dark metal family as
 * `streetlightMetal()` but a distinct, cooler shade, since the two are
 * near-identical silhouettes (slim pole + small head, see furniture.ts)
 * and were reading as the same object in the 3D view when they shared a
 * material outright. */
export function trafficSignalMetal(materials: MaterialLibrary) {
  return materials.shared("traffic-signal-metal", { color: 0x1c2b33, roughness: 0.45, metalness: 0.7 });
}

export function pergolaTimber(materials: MaterialLibrary) {
  return materials.shared("pergola-timber", { color: 0x8a6a45, roughness: 0.85 });
}

export function kioskBody(materials: MaterialLibrary) {
  return materials.shared("kiosk-body", { color: 0xcabfa9, roughness: 0.8 });
}

export function playgroundEquipment(materials: MaterialLibrary) {
  return materials.shared("playground-equipment", { color: 0xd94f70, roughness: 0.6 });
}

export function fitnessEquipment(materials: MaterialLibrary) {
  return materials.shared("fitness-equipment", { color: 0x3f8f8f, roughness: 0.5, metalness: 0.3 });
}
