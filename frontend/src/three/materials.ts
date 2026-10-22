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
import { activePack } from "../pack";
import type { CoverPaint } from "./builders/coverPaint";

export interface Surface {
  color: number;
  roughness: number;
  metalness?: number;
  /** Key into the vendored tiling ground textures. When set, `color` acts as a
   * tint over the texture rather than as the surface colour itself. */
  texture?: string;
  /** A path material painted on top of another ribbon (road markings): drawn
   * in front of it, lifted a little and not widened (see builders/paths.ts). */
  painted?: boolean;
}

const meanColors = new WeakMap<THREE.Texture, THREE.Color>();

/** The mean (linear) colour of a colour texture's image, measured once on
 * a small copy of it; mid grey if it can't be read (no texture, no
 * canvas). */
function meanColor(texture: THREE.Texture | null | undefined): THREE.Color {
  const known = texture ? meanColors.get(texture) : undefined;
  if (known) return known;
  const image = texture?.image as CanvasImageSource | undefined;
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  const ctx = canvas?.getContext("2d", { willReadFrequently: true });
  if (!texture || !image || !canvas || !ctx) return new THREE.Color(0.5, 0.5, 0.5);
  canvas.width = canvas.height = 32;
  ctx.drawImage(image, 0, 0, 32, 32);
  const data = ctx.getImageData(0, 0, 32, 32).data;
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += linear(data[i + k]);
  const n = data.length / 4;
  const color = new THREE.Color(sum[0] / n, sum[1] / n, sum[2] / n);
  meanColors.set(texture, color);
  return color;
}

/** Linear luminance (Rec. 709). */
function luminance(color: THREE.Color): number {
  return Math.max(0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b, 1e-3);
}

/** Whether a path material is painted on another ribbon (`Surface.painted`). */
export function isPaintedPath(material: string): boolean {
  return activePack().scene3d.pathSurfaces[material]?.painted === true;
}

/** The terrain casts shadows from its slopes facing away from the sun only.
 * A sunlit slope would otherwise shadow itself in stripes ("shadow acne")
 * that move with the sun: the sun's one shadow map spans the whole site,
 * about a metre a texel over a valley, far beyond what the shadow bias
 * (set for trunks and furniture, see Lighting.ts) covers. A ridge still
 * shades the valley behind it, from its far side. */
const TERRAIN_SHADOW_SIDE = THREE.BackSide;

const DEFAULT_COVER: Surface = { color: 0xd8d5cd, roughness: 0.9, texture: "paving" };
const DEFAULT_TERRAIN: Surface = { color: 0x7d8a5c, roughness: 1 };
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

// Same warm tone as the urban pack's streetlights (their
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

/** Leaves' autumn tint, blended in when drawing: each leaf cluster carries
 * its autumn colour as an attribute (`autumnColor`, see foliageCards.ts),
 * and the season's `autumnMix` mixes it over the summer `color` — so a
 * month change is a uniform, not new geometry. */
function withAutumnBlend(material: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const autumnMix = { value: 0 };
  material.userData.autumnMix = autumnMix;
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.autumnMix = autumnMix;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 autumnColor;\nuniform float autumnMix;")
      .replace(
        "#include <color_vertex>",
        "#include <color_vertex>\n#ifdef USE_COLOR\n  vColor.rgb = mix(vColor.rgb, autumnColor, autumnMix);\n#endif"
      );
  };
  material.customProgramCacheKey = () => `${previousKey()}|autumn-blend`;
  return material;
}

/** Sets how far `material` (a `foliage()` material) shows its autumn tint,
 * 0 (summer) to 1. */
export function setAutumnMix(material: THREE.Material, mix: number): void {
  const uniform = material.userData.autumnMix as { value: number } | undefined;
  if (uniform) uniform.value = mix;
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

  /** A material of the pack's (or anyone's), shared by key like the
   * library's own: created on first use from `surface`, lit by the lamps
   * like every other (see lampLighting.ts). */
  shared(key: string, surface: Surface): THREE.MeshStandardMaterial {
    return this.get(key, () => toMaterial(surface));
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
      const material = this.surfaceMaterial(activePack().scene3d.coverSurfaces[coverType] ?? DEFAULT_COVER);
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

  /** The bare ground of a site with terrain, where no cover is (see
   * builders/terrainSurface.ts): the pack's `terrainSurface`. Pushed back in
   * depth further than the covers, which lie on it. */
  terrain(): THREE.MeshStandardMaterial {
    return this.get("terrain", () => {
      const material = this.surfaceMaterial(activePack().scene3d.terrainSurface ?? DEFAULT_TERRAIN);
      // Both sides: seen from below (at the grid's edges, or from under a
      // slope) the ground is dark, lit from the wrong side, rather than
      // see-through to the sky. The same triangles, each still drawn once.
      material.side = THREE.DoubleSide;
      material.shadowSide = TERRAIN_SHADOW_SIDE;
      material.polygonOffset = true;
      material.polygonOffsetFactor = 3;
      material.polygonOffsetUnits = 3;
      return material;
    });
  }

  /** How a surface looks on average, from afar: its colour times its
   * texture's mean colour — the colour a cover is painted with (see
   * builders/coverPaint.ts), so that it reads as its mesh did. */
  averageColor(surface: Surface): THREE.Color {
    const map = surface.texture ? this.ground.get(surface.texture)?.map : undefined;
    const color = new THREE.Color(surface.color);
    return map ? color.multiply(meanColor(map)) : color;
  }

  /** The terrain with the covers painted on it (see builders/coverPaint.ts):
   * the colour from the covers' texture, the grain from the ground detail
   * texture's brightness (at its real scale), its relief and roughness as
   * the bare ground's. A material of its own, for one scene: the caller
   * disposes of it. */
  paintedTerrain(paint: CoverPaint): THREE.MeshStandardMaterial {
    const surface = activePack().scene3d.terrainSurface ?? DEFAULT_TERRAIN;
    const material = this.surfaceMaterial({ ...surface, color: 0xffffff });
    material.side = THREE.DoubleSide;
    material.shadowSide = TERRAIN_SHADOW_SIDE;
    material.polygonOffset = true;
    material.polygonOffsetFactor = 3;
    material.polygonOffsetUnits = 3;
    const uniforms = {
      coverMap: { value: paint.texture },
      coverOrigin: { value: new THREE.Vector2(...paint.origin) },
      coverSize: { value: new THREE.Vector2(...paint.size) },
      // The detail texture's mean brightness: grain only, not its colour.
      detailMean: { value: luminance(meanColor(material.map)) },
    };
    const previous = material.onBeforeCompile.bind(material);
    const previousKey = material.customProgramCacheKey.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      previous(shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform vec2 coverOrigin;\nuniform vec2 coverSize;\nvarying vec2 vCoverUv;")
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n  vCoverUv = ((modelMatrix * vec4(transformed, 1.0)).xz - coverOrigin) / coverSize;"
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform sampler2D coverMap;\nuniform float detailMean;\nvarying vec2 vCoverUv;")
        .replace(
          "#include <map_fragment>",
          [
            "  float grain = 1.0;",
            "  #ifdef USE_MAP",
            "    grain = dot(texture2D(map, vMapUv).rgb, vec3(0.2126, 0.7152, 0.0722)) / detailMean;",
            "  #endif",
            "  diffuseColor.rgb *= texture2D(coverMap, vCoverUv).rgb * grain;",
          ].join("\n")
        );
    };
    material.customProgramCacheKey = () => `${previousKey()}|painted-terrain`;
    return material;
  }

  path(material: string): THREE.MeshStandardMaterial {
    return this.get(`path:${material}`, () => {
      const mat = this.surfaceMaterial(activePack().scene3d.pathSurfaces[material] ?? DEFAULT_PATH);
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
      const isMarking = isPaintedPath(material);
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
      // the same way the urban pack's streetlights drive their night switch.
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
   * ingestion time (see civic_engagement/ingestion/ortofoto.py) — real per-building
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
      withAutumnBlend(
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

  dispose(): void {
    for (const material of this.cache.values()) material.dispose();
    this.cache.clear();
    // Ground textures are process-wide and cached in `assets.ts`; they outlive
    // any single viewer and are not disposed here.
  }
}
