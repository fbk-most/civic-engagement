/** Shared PBR materials for the realistic view.
 *
 * Colours here are deliberately *not* the ones in `map/layers.ts`: those are
 * flat unlit swatches picked to be legible on a top-down map, and they read as
 * washed out once a sun and an ambient sky are multiplied into them. These are
 * darker, less saturated albedo values chosen to land near the map's colours
 * after lighting.
 *
 * Where a surface carries a texture, its `color` stops being the surface
 * colour and becomes a tint multiplied over the map — hence the near-white
 * values on textured entries and the saturated ones on untextured entries.
 */

import * as THREE from "three";
import { addLampLighting } from "./lampLighting";
import { loadGroundTextures, type GroundTextureSet } from "./assets";
import { facadeEmissiveTexture, facadeNormalTexture, facadePatternTexture, facadeRoughnessTexture } from "./facade";
import { hashString } from "./hash";
import { daylightFraction } from "./sun";

interface Surface {
  color: number;
  roughness: number;
  metalness?: number;
  /** Key into the vendored tiling ground textures. When set, `color` acts as a
   * tint over the texture rather than as the surface colour itself. */
  texture?: string;
}

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
  crossing_marking: { color: 0xf2ecd8, roughness: 0.55 },
  lane_divider: { color: 0xf2ecd8, roughness: 0.55 },
};

const DEFAULT_COVER: Surface = { color: 0xd8d5cd, roughness: 0.9, texture: "paving" };
const DEFAULT_PATH: Surface = { color: 0xcac5be, roughness: 0.85, texture: "paving" };

// Facade tints by OSM `building` value. Trento's centre is rendered plaster,
// so these stay in a warm off-white to ochre range; the outliers are the
// station and the utilitarian structures around it.
const FACADE_COLORS: Record<string, number> = {
  church: 0xd8cfbc,
  train_station: 0xc9c3b6,
  transportation: 0xb8b4ad,
  parking: 0xa8a49d,
  garage: 0xa8a49d,
  garages: 0xa8a49d,
  service: 0xb0aca5,
  shed: 0xa39d94,
  roof: 0xa39d94,
};
const DEFAULT_FACADE_PALETTE = [0xd6c9b0, 0xcfc4ae, 0xd9cdb6, 0xc8bda8, 0xded2bb, 0xcabfa9];

const ROOF_COLOR = 0x8a5a44;

// Same warm tone as the streetlights (see builders/streetlights.ts's
// LIGHT_COLOR) — a square at night should read as one consistent colour
// temperature, not lamps and windows arguing with each other.
const WINDOW_GLOW_COLOR = 0xffcc88;
const WINDOW_EMISSIVE_MAX = 1.4;

/** Cut-off for foliage cards. Below 0.5 so crowns don't thin out as the mip
 * chain averages alpha down with distance, above the atlas's deepest-mip alpha
 * so they don't turn into solid blocks either. */
const FOLIAGE_ALPHA_TEST = 0.4;

function toMaterial(surface: Surface, extra?: THREE.MeshStandardMaterialParameters) {
  return addLampLighting(
    new THREE.MeshStandardMaterial({
      color: surface.color,
      roughness: surface.roughness,
      metalness: surface.metalness ?? 0,
      ...extra,
    })
  );
}

export class MaterialLibrary {
  private cache = new Map<string, THREE.MeshStandardMaterial>();
  private ground = new Map<string, GroundTextureSet>();
  // Facade materials are cached (and shared across every building of that
  // colour) by `color`, same as everything else in `cache` — but their
  // window-glow *intensity* is a live, altitude-driven value (see
  // `applyNightWindows`) rather than something picked once at creation, so
  // it needs its own list to iterate rather than being derivable from the
  // colour-keyed cache.
  private facadeMaterials: THREE.MeshStandardMaterial[] = [];

  /** Must be awaited before any material is requested: materials are cached on
   * first use, so a texture arriving later would never be attached to them. */
  async ensureTextures(): Promise<void> {
    if (this.ground.size === 0) this.ground = await loadGroundTextures();
  }

  private surfaceMaterial(surface: Surface): THREE.MeshStandardMaterial {
    const textures = surface.texture ? this.ground.get(surface.texture) : undefined;
    if (!textures) return toMaterial(surface, undefined);
    return toMaterial(surface, {
      map: textures.map,
      normalMap: textures.normalMap,
      // Relief strength already lives in the map itself (see
      // scripts/generate-ground-detail-maps.mjs's per-surface reliefM), so
      // this stays at the neutral 1:1 scale rather than doubling up a knob.
      normalScale: new THREE.Vector2(1, 1),
      roughnessMap: textures.roughnessMap,
    });
  }

  private get(key: string, create: () => THREE.MeshStandardMaterial) {
    let material = this.cache.get(key);
    if (!material) {
      material = create();
      this.cache.set(key, material);
    }
    return material;
  }

  cover(coverType: string): THREE.MeshStandardMaterial {
    return this.get(`cover:${coverType}`, () => {
      const material = this.surfaceMaterial(COVER_SURFACES[coverType] ?? DEFAULT_COVER);
      // Ground cover sits just below paths in Y (see shapes.ts's
      // PATH_HEIGHT_M/COVER_BAND_M), which is enough to fix draw order at
      // point-blank range but not reliably at real viewing distance — a
      // perspective camera's depth-buffer precision is concentrated near the
      // near plane, so a 2-8cm gap can fall inside one depth "bucket" a few
      // metres out and the two surfaces z-fight, sometimes losing to the
      // cover instead of the path. `polygonOffset` biases the *depth value*
      // a mesh writes, not its actual position, and that bias doesn't
      // degrade with distance — the standard fix for exactly this
      // "decal/overlay on the ground" case in any 3D engine.
      material.polygonOffset = true;
      material.polygonOffsetFactor = 1;
      material.polygonOffsetUnits = 1;
      return material;
    });
  }

  path(material: string): THREE.MeshStandardMaterial {
    return this.get(`path:${material}`, () => {
      const mat = this.surfaceMaterial(PATH_SURFACES[material] ?? DEFAULT_PATH);
      // The actual bug behind "paths are invisible": `builders/paths.ts`'s
      // ribbon triangles are geometrically wound facing *down* (confirmed by
      // computing the winding normal directly — it comes out (0,-20,0) for a
      // simple straight segment, despite the code explicitly pushing an "up"
      // (0,1,0) normal *attribute*). Three's default back-face culling goes
      // by the geometric winding, not the normal attribute, so every path
      // triangle was being culled from the normal above/oblique viewing
      // angle — nothing to do with z-fighting against ground cover, which
      // was the wrong diagnosis last round. DoubleSide is the safe fix here
      // (same reasoning as `foliage()`'s DoubleSide below: cheap for thin
      // geometry, and robust against re-deriving the correct sign convention
      // for every miter/join case instead of just this straight-segment one).
      mat.side = THREE.DoubleSide;
      // Opposite sign from `cover()`'s polygonOffset: that alone doesn't
      // separate path from cover, since a *matching* offset just moves both
      // surfaces back by the same amount and leaves them exactly as
      // z-fight-prone as before. This pushes paths *toward* the camera in
      // depth terms instead, so they win the comparison regardless of
      // viewing distance — the real, distance-independent half of the fix;
      // shapes.ts's PATH_HEIGHT_M margin is only a backup.
      //
      // Road markings (crossing stripes, lane dividers) are themselves a
      // path-like element drawn at the exact same nominal height, directly
      // on top of the street ribbon beneath them (see builders/paths.ts) —
      // an equal offset would leave *them* tied with the asphalt and flicker
      // exactly the way path/cover did before this offset existed. One more
      // step forward breaks that tie the same way.
      const isMarking = material === "crossing_marking" || material === "lane_divider";
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = isMarking ? -2 : -1;
      mat.polygonOffsetUnits = isMarking ? -2 : -1;
      return mat;
    });
  }

  /** Facade colour is keyed on the building kind when OSM knows it, otherwise
   * picked from a palette by a hash of the element id — a piazza of identical
   * boxes in one flat grey is the thing that most reads as "not real". */
  facade(elementId: string, buildingKind?: string): THREE.MeshStandardMaterial {
    const known = buildingKind ? FACADE_COLORS[buildingKind] : undefined;
    const color =
      known ?? DEFAULT_FACADE_PALETTE[hashString(elementId) % DEFAULT_FACADE_PALETTE.length];
    return this.get(`facade:${color}`, () => {
      const material = toMaterial(
        { color, roughness: 0.85 },
        {
          map: facadePatternTexture(),
          normalMap: facadeNormalTexture(),
          roughnessMap: facadeRoughnessTexture(),
          emissiveMap: facadeEmissiveTexture(),
          emissive: WINDOW_GLOW_COLOR,
        }
      );
      // Starts dark; applyNightWindows drives this from the sun's altitude
      // the same way builders/streetlights.ts drives its own night switch.
      material.emissiveIntensity = 0;
      this.facadeMaterials.push(material);
      return material;
    });
  }

  /** Fraction of a building's windows lit is fixed at texture-generation
   * time (see facade.ts's facadeEmissiveTexture) — this only drives *how
   * bright*, fading in over the same window `daylightFraction` uses for the
   * sun and streetlights so windows, streetlamps and the sky all read as one
   * consistent dusk rather than three separate cues disagreeing. */
  applyNightWindows(altitudeDeg: number): void {
    const intensity = (1 - daylightFraction(altitudeDeg)) * WINDOW_EMISSIVE_MAX;
    for (const material of this.facadeMaterials) material.emissiveIntensity = intensity;
  }

  /** `tint` is the median roof colour sampled from the 2015 orthophoto at
   * ingestion time (see civic_twin/ingestion/ortofoto.py) — real per-building
   * colour where the site has it, the generic default elsewhere. */
  roof(tint?: string): THREE.MeshStandardMaterial {
    const color = tint ? parseInt(tint.slice(1), 16) : ROOF_COLOR;
    return this.get(`roof:${color}`, () => toMaterial({ color, roughness: 0.8 }));
  }

  /** Broadleaf clusters only — evergreens use `needles()` below, which
   * needs no texture at all. Per-cluster tint (species-appropriate green,
   * seasonal autumn grade, and a little per-cluster random jitter) is baked
   * as a vertex `color` attribute in `foliageCards.ts` instead of chosen
   * here — leaf geometry from every tree in the scene is merged into one
   * mesh (see `vegetation.ts`), so a single material color can no longer
   * vary tree-to-tree the way an old per-variant cached material did.
   *
   * Alpha-tested rather than blended: cut-out foliage then casts correct
   * shadows through the standard depth pass and needs no depth sorting.
   */
  foliage(atlas: THREE.Texture): THREE.MeshStandardMaterial {
    return this.get(`foliage:${atlas.uuid}`, () =>
      toMaterial(
        { color: 0xffffff, roughness: 0.9 },
        {
          map: atlas,
          vertexColors: true,
          alphaTest: FOLIAGE_ALPHA_TEST,
          // Clusters are thin planes seen from both sides as the camera
          // moves through a crown.
          side: THREE.DoubleSide,
        }
      )
    );
  }

  /** Evergreen needles (`builders/needles.ts`): solid untextured triangles,
   * so unlike `foliage()` there's no atlas to key the cache on — one shared
   * instance is enough. Colour comes entirely from the geometry's vertex
   * `color` attribute, same reasoning as `foliage()`. No `alphaTest` (there's
   * no alpha channel to cut out, these are opaque triangles), but still
   * `DoubleSide` since a paper-thin needle is otherwise invisible from
   * its back face. */
  needles(): THREE.MeshStandardMaterial {
    return this.get("needles", () =>
      toMaterial({ color: 0xffffff, roughness: 0.95 }, { vertexColors: true, side: THREE.DoubleSide })
    );
  }

  bark(): THREE.MeshStandardMaterial {
    return this.get("bark", () => toMaterial({ color: 0x6b5340, roughness: 0.95 }));
  }

  furniture(): THREE.MeshStandardMaterial {
    return this.get("furniture", () => toMaterial({ color: 0x6f6a63, roughness: 0.8 }));
  }

  waterFeature(): THREE.MeshStandardMaterial {
    return this.get("water-feature", () =>
      toMaterial({ color: 0x3f6f92, roughness: 0.15, metalness: 0.1 })
    );
  }

  /** Streetlight pole/lamp housing. The actual night-time glow comes from a
   * real `THREE.PointLight` per streetlight (see `builders/streetlights.ts`),
   * not from this material, so it stays a plain dark metal at all hours. */
  streetlightMetal(): THREE.MeshStandardMaterial {
    return this.get("streetlight-metal", () => toMaterial({ color: 0x2e2e2e, roughness: 0.5, metalness: 0.6 }));
  }

  /** Streetlight globe: frosted glass by day; `applyNightLights` (see
   * `builders/streetlights.ts`) drives its emissive glow after dark. */
  streetlightGlobe(): THREE.MeshStandardMaterial {
    return this.get("streetlight-globe", () => toMaterial({ color: 0xe8e4da, roughness: 0.35 }));
  }

  /** Traffic signal pole/housing — same dark metal family as
   * `streetlightMetal()` but a distinct, cooler shade, since the two are
   * near-identical silhouettes (slim pole + small head, see furniture.ts)
   * and were reading as the same object in the 3D view when they shared a
   * material outright. */
  trafficSignalMetal(): THREE.MeshStandardMaterial {
    return this.get("traffic-signal-metal", () => toMaterial({ color: 0x1c2b33, roughness: 0.45, metalness: 0.7 }));
  }

  pergolaTimber(): THREE.MeshStandardMaterial {
    return this.get("pergola-timber", () => toMaterial({ color: 0x8a6a45, roughness: 0.85 }));
  }

  kioskBody(): THREE.MeshStandardMaterial {
    return this.get("kiosk-body", () => toMaterial({ color: 0xcabfa9, roughness: 0.8 }));
  }

  playgroundEquipment(): THREE.MeshStandardMaterial {
    return this.get("playground-equipment", () => toMaterial({ color: 0xd94f70, roughness: 0.6 }));
  }

  fitnessEquipment(): THREE.MeshStandardMaterial {
    return this.get("fitness-equipment", () => toMaterial({ color: 0x3f8f8f, roughness: 0.5, metalness: 0.3 }));
  }

  dispose(): void {
    for (const material of this.cache.values()) material.dispose();
    this.cache.clear();
    // Ground textures are process-wide and cached in `assets.ts`; they outlive
    // any single viewer and are not disposed here.
  }
}
