/** Ripples + real-time reflection for the "water" ground cover (the pond).
 *
 * `materials.ts`'s flat, static `waterFeature()` material still covers the
 * *discrete* fountain elements — a different, much smaller feature that
 * doesn't need any of this.
 *
 * Built on three's own `Water` object (the classic webgl_shaders_ocean
 * shader): animated ripple normals sampled from `waterNormalTexture()`,
 * blended with a genuine planar reflection it renders into its own texture
 * every frame, and a sun specular highlight driven by the site's real sun
 * direction — see Viewer.tsx for the per-frame (`eye`/`time`) and
 * per-sun-change (`sunDirection`/`sunColor`) uniform updates this needs from
 * the render loop, since a `Water` instance doesn't know about either on its
 * own.
 */

import * as THREE from "three";
import { Water } from "three/examples/jsm/objects/Water.js";
import type { CoverPolygon } from "../../api/types";
import type { GeoAnchor } from "../geo";
import { geometryToShapes, outlineHeightRange } from "../shapes";
import type { Terrain } from "../terrain";
import { daylightFraction, type SunPosition } from "../sun";
import { waterNormalTexture } from "../water";
import type { ScenePart } from "../parts";
import { activePack } from "../../pack";

// Muted, slightly murky green-brown rather than a clean blue — closer to
// how a small, still urban pond actually looks (sediment/algae, not open
// clear water) than the blue that read as an artificial tint.
const WATER_COLOR = 0x24382c;
// How large a world-space stretch one tile of the ripple texture covers.
// Tuned for a pond this size (a few hundred m2, not an open sea) — much
// smaller and the ripples read as a printed pattern rather than water.
const RIPPLE_SIZE = 2.5;
// Three's own ocean demo uses 3.7 for open water; this pond is calmer, but
// the original 1.2 here left reflections almost undistorted — closer to a
// literal mirror than water — at any angle, not just straight down.
const DISTORTION_SCALE = 3.2;

/** The pack's water covers (`FrontendPack.scene3d.waterCoverTypes`) as
 * animated water surfaces, rippling every frame and lit by the sun. */
export function buildWater(covers: CoverPolygon[], anchor: GeoAnchor, terrain: Terrain): ScenePart {
  const group = new THREE.Group();
  group.name = "water";
  const surfaces: Water[] = [];
  const waterTypes = new Set(activePack().scene3d.waterCoverTypes);

  for (const cover of covers) {
    if (!waterTypes.has(cover.cover_type)) continue;
    const shapes = geometryToShapes(anchor, cover.geometry);
    if (shapes.length === 0) continue;

    const water = new Water(new THREE.ShapeGeometry(shapes), {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: waterNormalTexture(),
      sunDirection: new THREE.Vector3(0, 1, 0),
      sunColor: 0xffffff,
      waterColor: WATER_COLOR,
      distortionScale: DISTORTION_SCALE,
      fog: false,
    });
    // Not a constructor option despite the shader having a `size` uniform —
    // Water.js's own constructor never reads `options.size` (checked its
    // source directly), so this has to be set after the fact or it silently
    // stays at the shader's default of 1.0.
    water.material.uniforms.size.value = RIPPLE_SIZE;
    // Water.js's Fresnel term asymptotes to a near-total (rf0 -> 1.0)
    // reflection at grazing angles with no ceiling — physically correct for
    // still water, but at the shallow angles an eye-level camera actually
    // sees a pond from, it reads as a near-perfect mirror rather than water.
    // Same string-patch technique Lighting.ts uses on Sky.js: capped so
    // waterColor always shows through at least a little, and the exponent
    // softened so the colour-to-reflection transition isn't a hard flip.
    water.material.fragmentShader = water.material.fragmentShader.replace(
      "float reflectance = rf0 + ( 1.0 - rf0 ) * pow( ( 1.0 - theta ), 5.0 );",
      "float reflectance = min( 0.55, rf0 + ( 1.0 - rf0 ) * pow( ( 1.0 - theta ), 3.0 ) );"
    );
    water.material.needsUpdate = true;
    // ShapeGeometry lies flat in local XY with +Z as the face normal — the
    // same convention shapes.ts's flatGeometry rotates away for ordinary
    // ground meshes. Water reads its mirror-plane normal straight off the
    // mesh's own world matrix each frame (see its onBeforeRender), so this
    // has to be a real Object3D transform, not baked into the geometry the
    // way flatGeometry bakes it.
    water.rotation.x = -Math.PI / 2;
    // Slightly *below* ground level: a pond reads as a basin sunk into the
    // ground, not a film sitting on top of it, which a small positive offset
    // (matching how ordinary covers stack, see shapes.ts's COVER_BAND_M)
    // got backwards. Kept shallow — there's no bank/edge geometry here, so a
    // deeper cut would show as a visible cliff at the shoreline instead of a
    // basin.
    // Level, at the highest ground around it on a slope (there are no banks
    // to hold it lower: it would sink under the ground's surface).
    const [, shore] = outlineHeightRange(terrain, anchor, cover.geometry);
    water.position.y = shore - 0.03;
    water.name = cover.id;
    group.add(water);
    surfaces.push(water);
  }

  return {
    object: group,
    // A rebuild's fresh Water instances start with a placeholder sun
    // direction until this runs — without it a pond would briefly show the
    // wrong specular highlight after every model edit, not just the ones
    // that happen to also change the sun.
    setSun: (sun) => updateWaterSun(surfaces, sun),
    frame: (camera, elapsedS) => {
      for (const water of surfaces) {
        water.material.uniforms.time.value = elapsedS;
        water.material.uniforms.eye.value.copy(camera.position);
      }
    },
  };
}

/** Points the sun-specular highlight at the site's real sun and fades its
 * brightness with the same daylight curve everything else uses — without
 * this, `Water`'s own default direction is meaningless for this scene, and
 * a fixed-brightness highlight would keep glinting at full strength after
 * the actual directional light has faded out for the night. */
function updateWaterSun(surfaces: Water[], sun: SunPosition): void {
  const brightness = daylightFraction(sun.altitudeDeg);
  for (const water of surfaces) {
    water.material.uniforms.sunDirection.value.copy(sun.direction);
    water.material.uniforms.sunColor.value.setRGB(brightness, brightness, brightness);
  }
}
