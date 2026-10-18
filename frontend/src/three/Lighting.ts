/** Sun and sky.
 *
 * Not decoration: the tool's headline indicators (thermal comfort, cooling
 * delta, CO2) are all really about shade, so a correctly placed sun is what
 * lets the 3D view make the same argument the indicators panel makes
 * numerically. The sun direction comes from a real solar position for the
 * site's latitude and the chosen date/time (see `sun.ts`), never from an
 * art-directed angle.
 *
 * Ambient light is the Preetham sky itself, prefiltered into an environment
 * map, rather than a hemisphere light: a physical sky gives the right blue
 * fill in shadow and the right warm bounce near sunset, both of which a
 * two-colour hemisphere approximation gets visibly wrong.
 */

import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { daylightFraction, type SunPosition } from "./sun";

/** Shadow map resolution. 4096 over a ~400 m site is roughly 10 cm per texel,
 * enough to keep individual tree crowns readable. Clamped to whatever the GPU
 * reports, which is the binding constraint on venue laptops. */
const SHADOW_MAP_SIZE = 4096;

/** How far back along the sun direction the directional light sits. Only
 * affects the shadow camera's placement, not the shading. */
const SUN_DISTANCE_M = 400;

const SKY_RADIUS = 45000;

/** The base three.js `Sky` is a daytime atmospheric-scattering model with no
 * night-sky term, so once the sun fades out both it and the environment map
 * it feeds go essentially black — without a floor, everything outside a
 * streetlight's reach would be pure black rather than a dim, walkable night.
 * This is a flat "moon + skyglow" stand-in, not a simulated moon position. */
const NIGHT_AMBIENT_INTENSITY = 0.35;

export interface SiteBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export class Lighting {
  readonly sun: THREE.DirectionalLight;
  private moonlight: THREE.HemisphereLight;

  private scene: THREE.Scene;
  private sky: Sky;
  private pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envScene = new THREE.Scene();
  private center = new THREE.Vector3();
  private sunDistance = SUN_DISTANCE_M;
  /** How much of the sun disc should show in the *main* scene, as opposed to
   * the temporary 0 forced during environment-map capture (see
   * `refreshEnvironment`). Kept as state because the shader's disc term is
   * purely angular — view ray vs. sun direction — with no notion of a true
   * horizon, so left alone it renders identically whether the sun is 30°
   * up or 5° below ("the sun is visible when it should be below the
   * horizon"). Driven by the same altitude fade as the sun's own intensity. */
  private sunDiscVisibility = 0;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;

    this.sky = new Sky();
    this.sky.scale.setScalar(SKY_RADIUS);
    if (renderer.capabilities.reversedDepthBuffer) {
      // Sky.js pins the sky to the far plane by its depth, which a reversed
      // depth buffer (see Viewer.tsx) turns into the near one: the sky is
      // drawn first instead, behind everything, with no depth at all. First
      // means the highest order: with a reversed depth buffer, three.js
      // draws the opaque objects in the reverse of their sorted order.
      this.sky.material.depthTest = false;
      this.sky.material.depthWrite = false;
      this.sky.renderOrder = 1e9;
    }
    const uniforms = this.sky.material.uniforms;
    uniforms.turbidity.value = 4;
    uniforms.rayleigh.value = 2;
    // Both were three's own Sky.js defaults, which is exactly the problem:
    // that shader's Mie term is a *forward-scattering* lobe (`mieDirectionalG`
    // is how tight/bright it is around the sun direction itself, not the sky
    // in general), and 0.8 is tight and bright enough that when the sun is
    // low and near the view direction — sunrise/sunset, exactly when a
    // facilitator is most likely to be checking shade — it blows out into a
    // huge, near-white corona. That corona isn't just visually loud on its
    // own: it also gets baked into `scene.environment` (see
    // `refreshEnvironment` below), so it washes out every object's ambient
    // lighting too, not just the visible sky. A first, smaller cut (0.7/0.003)
    // was not nearly enough — screenshots at low sun altitude still showed a
    // large, near-white corona washing out the whole scene — so this is a much
    // more aggressive reduction, plus a hard clamp below as a backstop rather
    // than relying on parameter tuning alone to hit the right number blind.
    uniforms.mieCoefficient.value = 0.0015;
    uniforms.mieDirectionalG.value = 0.45;
    uniforms.cloudCoverage.value = 0.35;
    uniforms.cloudDensity.value = 0.35;
    scene.add(this.sky);

    // Sky.js's fragment shader is a fixed GLSL string (not composed from
    // material.onBeforeCompile-able chunks), so it's patched directly rather
    // than fought via uniforms alone:
    // - The sun disc's own brightness multiplier (19000, three's demo value)
    //   is cut independently of the broader Mie glow above, since screenshots
    //   showed a small hard-white disc *and* a separate large soft corona —
    //   two different terms in this shader, both needed taming.
    // - `min(texColor, vec3(HDR_CAP))` is a firefly-style clamp: a hard
    //   ceiling on the sky's own output radiance, regardless of which
    //   combination of physical parameters would otherwise spike it. This is
    //   the backstop for whatever the parameter cuts above don't catch, and
    //   it applies equally to the directly-visible sky and to whatever gets
    //   baked into the environment map below.
    const HDR_CAP = 4.0;
    this.sky.material.fragmentShader = this.sky.material.fragmentShader
      .replace("vSunE * 19000.0", "vSunE * 4000.0")
      .replace(
        "gl_FragColor = vec4( texColor, 1.0 );",
        `gl_FragColor = vec4( min( texColor, vec3( ${HDR_CAP.toFixed(1)} ) ), 1.0 );`
      );
    this.sky.material.needsUpdate = true;

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();

    this.sun = new THREE.DirectionalLight(0xfff2e0, 2.6);
    this.sun.castShadow = true;
    const size = Math.min(SHADOW_MAP_SIZE, renderer.capabilities.maxTextureSize);
    this.sun.shadow.mapSize.set(size, size);
    // Trunks and thin furniture acne badly at this scale without a normal
    // bias; a plain constant bias large enough to fix it would detach the
    // tree shadows from their trunks instead.
    //
    // normalBias pushes a *receiver's* sampled point along its own surface
    // normal before the shadow test — for the flat ground, straight up. A
    // fixed vertical push like that turns into a much bigger apparent gap on
    // the ground as the sun gets lower: the shadow-side displacement is
    // roughly normalBias / tan(sun altitude), so the same bias that's
    // invisible at midday grows sharply at dawn/dusk. That's why this kept
    // reading as "furniture floats above its own shadow" specifically at low
    // sun angles even after the first cut (0.05 -> 0.015) — confirmed by
    // comparing renders at several sun altitudes with the actual gap size.
    // Cut further; verified clean (no reappearing trunk acne) at noon and
    // markedly smaller furniture gaps at ~6-11° altitude, though a fully
    // grazing sun will still show some — a single shadow map fundamentally
    // trades this off against acne, and a fix that holds at every angle
    // would need a different technique (contact shadows, cascaded shadow
    // maps), not another bias tweak.
    //
    // `bias` itself was the bigger offender once traced through: see fitTo's
    // comment below on how far it actually reached in world metres given the
    // shadow camera's near/far span. -0.0005 there was worth ~0.5m on the
    // ground — invisible against a building, but bigger than an entire tree
    // trunk, which is why a trunk's own shadow could read as fully detached
    // rather than just nudged. Now that fitTo keeps near/far tight, this can
    // be a correspondingly small number instead.
    this.sun.shadow.bias = -0.00006;
    this.sun.shadow.normalBias = 0.005;
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Cool sky / dark warm ground, like the rest of the codebase's non-shadow
    // fill lights — starts at 0 and only ramps in as the sun fades (see
    // setSun), so it never competes with daylight.
    this.moonlight = new THREE.HemisphereLight(0x3b4a6b, 0x1c1c1a, 0);
    scene.add(this.moonlight);
  }

  /** Advances the cloud animation. Cheap — one uniform write per frame. */
  update(elapsedSeconds: number): void {
    this.sky.material.uniforms.time.value = elapsedSeconds;
  }

  /** Fits the shadow camera to the site so shadow texels aren't spent on empty
   * space. Call once per scene rebuild. `heights`: the ground's lowest and
   * highest point over it (both 0 on a flat site). */
  fitTo(bounds: SiteBounds, heights: [number, number] = [0, 0]): void {
    this.center.set((bounds.minX + bounds.maxX) / 2, (heights[0] + heights[1]) / 2, (bounds.minZ + bounds.maxZ) / 2);
    // Padded so buildings just outside the boundary still cast into the square,
    // which around Piazza Dante is most of what shades it in the afternoon.
    const radius = Math.hypot(Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2 + 80, (heights[1] - heights[0]) / 2);
    // The sun stands outside everything it lights, however large the site.
    this.sunDistance = Math.max(SUN_DISTANCE_M, radius + 100);

    const camera = this.sun.shadow.camera;
    camera.left = -radius;
    camera.right = radius;
    camera.top = radius;
    camera.bottom = -radius;
    // For an orthographic shadow camera, three.js applies `bias` directly to
    // the *normalized* [0,1] depth (see shadowmap_pars_fragment.glsl.js's
    // `shadowCoord.z += shadowBias`), which for an orthographic projection is
    // linear across [near,far] — so the same `bias` value is worth
    // `bias * (far - near)` in actual world metres. The previous near=1,
    // far=SUN_DISTANCE_M*2+radius (≈1018) range was hugely wider than the
    // scene ever needs (every shadow-casting/receiving object sits within
    // `radius` of `center`, i.e. within [SUN_DISTANCE_M-radius,
    // SUN_DISTANCE_M+radius] of the light along its own view axis), so a
    // "small-looking" bias of 0.0005 was actually worth ~0.5m on the ground —
    // negligible against a building's shadow, but comparable to a whole tree
    // trunk's own footprint, which is why thin trunks specifically read as
    // detached from their shadow (confirmed by back-projecting the screen-space
    // gap in a real capture into world metres). Tightened to the range the
    // site actually occupies plus a margin for building height, which lets
    // `bias` below be a correspondingly smaller, sane number.
    // Clamped to stay positive: a site large enough that radius exceeds
    // SUN_DISTANCE_M - 30 would otherwise push `near` to zero or negative,
    // which is invalid for a camera. Piazza Dante's radius (~218m) is nowhere
    // close, but nothing here should silently break if this tool is ever
    // pointed at a much bigger site.
    camera.near = Math.max(1, this.sunDistance - radius - 30);
    camera.far = this.sunDistance + radius + 30;
    camera.updateProjectionMatrix();

    this.sky.position.copy(this.center);
    this.sun.target.position.copy(this.center);
    this.sun.target.updateMatrixWorld();
  }

  setSun(position: SunPosition): void {
    const { direction, altitudeDeg } = position;

    this.sun.position
      .copy(direction)
      .multiplyScalar(this.sunDistance)
      .add(this.center);

    // Below the horizon a directional light would light the scene from
    // underneath. Fade it out across the last few degrees so dusk ramps down
    // smoothly instead of snapping to black.
    const daylight = daylightFraction(altitudeDeg);
    this.sun.intensity = 2.6 * daylight;
    // Same window, inverted: the ambient floor ramps in exactly as the sun
    // ramps out, so there's no gap where neither is providing light.
    this.moonlight.intensity = NIGHT_AMBIENT_INTENSITY * (1 - daylight);
    this.sunDiscVisibility = daylight;

    this.sky.material.uniforms.sunPosition.value.copy(direction);
    this.refreshEnvironment();
  }

  /** Re-prefilters the sky into the scene's environment map. Only runs when
   * the sun moves (a user action), not per frame. */
  private refreshEnvironment(): void {
    this.envTarget?.dispose();
    // The sun disc is a tiny, extremely bright feature; leaving it in the
    // prefiltered map produces a blotchy ambient term (three's own guidance).
    this.sky.material.uniforms.showSunDisc.value = 0;
    this.envScene.add(this.sky);
    this.envTarget = this.pmrem.fromScene(this.envScene);
    this.scene.add(this.sky);
    this.sky.material.uniforms.showSunDisc.value = this.sunDiscVisibility;

    this.scene.environment = this.envTarget.texture;
  }

  dispose(): void {
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
  }
}
