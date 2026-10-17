import type { FrontendPack, Surface } from "civic-engagement";
import { buildFurniture } from "./three/furnitureParts";
import { buildStreetlightPart } from "./three/streetlights";

// The urban scene in 3D (see the core's pack.ts `scene3d`): how covers and
// paths look, and the pack's own parts (furniture, streetlights).

const COVER_SURFACES: Record<string, Surface> = {
  paving: { color: 0xd8d5cd, roughness: 0.9, texture: "paving" },
  gravel: { color: 0xd6cfc0, roughness: 1.0, texture: "gravel" },
  // Shares the gravel texture with a green cast: permeable paving is a
  // grass-and-aggregate surface, and at ground level the pattern is what reads.
  permeable_paving: { color: 0xb9c9ac, roughness: 0.95, texture: "gravel" },
  lawn: { color: 0xd9e8c8, roughness: 0.95, texture: "lawn" },
  meadow: { color: 0xd8dba2, roughness: 0.95, texture: "lawn" },
  wood: { color: 0x7d9c72, roughness: 0.95, texture: "lawn" },
  water: { color: 0x3f6f92, roughness: 0.15, metalness: 0.1 },
};

// Keys span both OSM `surface` values found in the baseline (sett,
// paving_stones, asphalt, ...) and the `material` options offered by the
// "nuovo percorso" card (gravel, permeable_paving, wood).
const PATH_SURFACES: Record<string, Surface> = {
  sett: { color: 0xc9c4bc, roughness: 0.9, texture: "sett" },
  unhewn_cobblestone: { color: 0xbfb9b0, roughness: 1.0, texture: "sett" },
  paving_stones: { color: 0xd2cdc5, roughness: 0.85, texture: "paving" },
  paving: { color: 0xd2cdc5, roughness: 0.85, texture: "paving" },
  paved: { color: 0xcac5be, roughness: 0.85, texture: "paving" },
  concrete: { color: 0xd6d4cf, roughness: 0.9, texture: "paving" },
  // Dry asphalt is quite matte; at 0.8 lamps left a strong glint on it at
  // night. (Wet weather, if ever modelled, would lower this.)
  asphalt: { color: 0xbdbbb8, roughness: 0.92, texture: "asphalt" },
  fine_gravel: { color: 0xe0d8c8, roughness: 1.0, texture: "gravel" },
  gravel: { color: 0xd6cfc0, roughness: 1.0, texture: "gravel" },
  permeable_paving: { color: 0xb9c9ac, roughness: 0.95, texture: "gravel" },
  wood: { color: 0x7a5a35, roughness: 0.85 },
  // Painted road markings (crossing stripes, lane dividers) — a bright,
  // slightly warm off-white, distinct from the asphalt/paving they sit on.
  // Untextured, same as `wood` above: there's no vendored "paint" tile.
  crossing_marking: { color: 0xf2ecd8, roughness: 0.55, painted: true },
  lane_divider: { color: 0xf2ecd8, roughness: 0.55, painted: true },
};

export const SCENE_3D: FrontendPack["scene3d"] = {
  coverSurfaces: COVER_SURFACES,
  pathSurfaces: PATH_SURFACES,
  // Streets, crossing stripes and lane dividers are all LineString/
  // MultiLineString elements with their own `material` (see
  // ingestion/build_baseline.py), drawn like pedestrian paths.
  ribbonTypes: ["path", "street", "crossing", "lane_divider"],
  waterCoverTypes: ["water"],
  parts: [buildFurniture, buildStreetlightPart],
};
