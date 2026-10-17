/** Streetlights are the one furniture type that can't be purely instanced:
 * lamps need live `THREE.PointLight`s so the square visibly lights up at
 * night, which is the whole point of the card (see `add_streetlight` and the
 * `safety_score` indicator). The pole itself is still instanced — only the
 * light is per-object.
 *
 * Real lights are expensive per pixel: every lit surface is shaded against
 * every active light, and with one light per lamp (~75 in Piazza Dante) a
 * night frame took seven times as long as a day one on an integrated GPU
 * (measured with the `?perf=1` benchmark). So only the lamps nearest the
 * camera get a real light (with shadows, as before); every other lamp is lit
 * by the same light minus shadows, computed in the materials themselves
 * (three/lampLighting.ts) — about 3.7x faster at night on that GPU, and
 * visually close. `?lights=all` in the URL restores one real light per lamp,
 * for comparison.
 *
 * (Also tried and dropped: real lights near the camera only, with a light
 * pool painted on the ground under the others — fast, but distant buildings
 * and trees went dark.)
 */

import * as THREE from "three";
import {
  daylightFraction,
  readDebugParams,
  setLampIntensity,
  setLampLayout,
  setRealLamps,
  toLocal,
  type DiscreteElement,
  type GeoAnchor,
  type MaterialLibrary,
  type PartBuilder,
  type Terrain,
} from "civic-engagement";
import { buildStreetlightGlobeGeometry, buildStreetlightPoleGeometry, STREETLIGHT_GLOBE_Y_M } from "./furniture";
import { streetlightGlobe, streetlightMetal } from "./materials";

// Read once: comparison/test switches, not something that changes live.
const DEBUG = readDebugParams();
const CHEAP = DEBUG.nightLights === "cheap";
// Real lights near what's in view, all casting shadows; `?realLights=N` to
// try other counts. Each shadow-casting light takes a texture
// unit in every material's shader, hence the hard ceiling.
// 8 measured no slower than 6 on an integrated GPU (Radeon 860M).
const REAL_LIGHTS = Math.min(10, Math.max(1, Math.round(DEBUG.realLights ?? 8)));

const LIGHT_COLOR = 0xffcc88;
// three's PointLight intensity is in candela (physically-based units) with
// inverse-square falloff via `decay` — nothing like the sun's DirectionalLight
// scale (see Lighting.ts's 2.6), which has no distance falloff at all. A
// value in the low tens is imperceptible once ACES tonemapping and the
// scene's 0.5 exposure are applied; this is tuned to actually read as a lit
// lamp at a few metres.
const LIGHT_INTENSITY = 450;
const LIGHT_DISTANCE_M = 18;
// Inside the globe. The cap sits within SHADOW_CAMERA_NEAR_M of it, so it
// doesn't blot out the lamp's own shadow map.
const LIGHT_HEIGHT_M = STREETLIGHT_GLOBE_Y_M;

// Cube shadow maps are comparatively small here (see updateStreetlightShadows'
// MAX_SHADOW_CASTERS below for why only a handful of these are ever active at
// once): 512 is plenty to keep a lamp-post's own shadow crisp at the ~18m
// range it actually illuminates, without the render cost of a 4096 map times
// 6 cube faces times several simultaneous lights.
const SHADOW_MAP_SIZE = 512;
// Tightened to the light's own illumination range rather than three's default
// (0.5-500): nothing past LIGHT_DISTANCE_M is meaningfully lit anyway, and —
// same lesson as the sun's shadow camera in Lighting.ts's fitTo — a point
// light's shadow bias is also applied to depth normalized across
// [near,far], so an unnecessarily wide range would force a correspondingly
// large, ground-detaching bias just to avoid acne.
const SHADOW_CAMERA_NEAR_M = 0.5;
const SHADOW_CAMERA_FAR_M = LIGHT_DISTANCE_M + 5;

export interface StreetlightBuild {
  poleMesh: THREE.InstancedMesh | null;
  globeMesh: THREE.InstancedMesh | null;
  /** The real lights near the camera (default), or one per lamp
   * (`?lights=all`). */
  lights: THREE.PointLight[];
  /** Where each lamp's light sits. */
  lamps: THREE.Vector3[];
  /** Which lamp each real light is on (-1: none yet); unused with
   * `?lights=all`. */
  assigned: number[];
}

export function buildStreetlights(
  elements: DiscreteElement[],
  anchor: GeoAnchor,
  materials: MaterialLibrary,
  terrain: Terrain
): StreetlightBuild {
  const transforms: THREE.Matrix4[] = [];
  const lights: THREE.PointLight[] = [];
  const lamps: THREE.Vector3[] = [];

  for (const element of elements) {
    if (element.type !== "streetlight" || element.geometry.type !== "Point") continue;
    const [lng, lat] = element.geometry.coordinates;
    const [x, z] = toLocal(anchor, lng, lat);
    const y = terrain.heightAt(x, z);
    transforms.push(new THREE.Matrix4().setPosition(x, y, z));
    lamps.push(new THREE.Vector3(x, y + LIGHT_HEIGHT_M, z));
  }

  const lightCount = CHEAP ? Math.min(REAL_LIGHTS, lamps.length) : lamps.length;
  for (let i = 0; i < lightCount; i++) {
    const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_DISTANCE_M, 2);
    light.position.copy(lamps[i]);
    light.visible = false;
    // Tried castShadow=true on all ~75 of these, at the user's request, to
    // see whether the cost was tolerable. It was worse than slow: every
    // shadow-casting PointLight needs its own depth-cubemap sampler in the
    // fragment shader of *every* material that can receive its light, and
    // with dozens of streetlights simultaneously lit at night/dusk, ground
    // and building materials blew past MAX_TEXTURE_IMAGE_UNITS and failed to
    // compile — confirmed by comparing a noon render against a dusk render
    // from the identical camera pose: the ground/building silhouette that
    // was clearly there at noon was completely absent at dusk, replaced by
    // uninterrupted sky, which is what a material falling back to not
    // rendering at all looks like. That's a plausible chunk of the
    // "buildings don't block the sun" and "objects float" reports, not just
    // a frame-rate cost.
    //
    // Shadow config is set up-front even though castShadow starts false:
    // `updateStreetlightShadows` (below) flips it on/off per-light every
    // frame based on proximity to the camera, and reconfiguring mapSize/
    // camera near-far on a light that's already in the shadow-casting set
    // would be wasted work.
    light.castShadow = false;
    light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    light.shadow.camera.near = SHADOW_CAMERA_NEAR_M;
    light.shadow.camera.far = SHADOW_CAMERA_FAR_M;
    // The scene is static apart from the camera (see `updateStreetlightShadows`'s
    // docstring below for what actually invalidates a lamp's own shadow map) —
    // a point light shadow doesn't need re-rendering just because another
    // frame ticked. Off here, flipped on for exactly one frame at a time by
    // `updateStreetlightShadows` when a light's occluders could actually have
    // changed.
    light.shadow.autoUpdate = false;
    // Worth ~bias*(far-near) in real-world metres (see the SHADOW_CAMERA_*_M
    // comment above) — with that range now tight at ~22.5m, this is a couple
    // of centimetres, enough to kill acne on the ground right under the lamp
    // without visibly detaching the shadow from the pole. Revisit if either
    // symptom reappears.
    light.shadow.bias = -0.0015;
    light.shadow.normalBias = 0.02;
    lights.push(light);
  }

  let poleMesh: THREE.InstancedMesh | null = null;
  let globeMesh: THREE.InstancedMesh | null = null;
  if (transforms.length > 0) {
    poleMesh = instanced(buildStreetlightPoleGeometry(), streetlightMetal(materials), transforms, "streetlights");
    globeMesh = instanced(buildStreetlightGlobeGeometry(), streetlightGlobe(materials), transforms, "streetlight-globes");
  }
  if (CHEAP) setLampLayout(lamps, LIGHT_DISTANCE_M, LIGHT_COLOR);

  return { poleMesh, globeMesh, lights, lamps, assigned: lights.map(() => -1) };
}

function instanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  transforms: THREE.Matrix4[],
  name: string
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
  transforms.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = name;
  mesh.frustumCulled = false;
  return mesh;
}

// Bounds how many streetlights cast shadows at once, independent of how many
// are on site (Piazza Dante's baseline alone has ~75). This is the actual
// fix for the shader-compile-failure bug documented above: a receiving
// material's fragment shader needs one depth-cubemap sampler per
// shadow-casting light *currently affecting it*, and that has to stay well
// under the GPU's texture-unit budget alongside the base colour/normal/
// roughness/AO maps and the sun's own shadow map it's already using. Six is
// comfortably safe for that budget while still being enough to notice —
// nobody standing in the square is visually close to more than a few lamps
// at once anyway.
const MAX_SHADOW_CASTERS = 6;

/** Re-picks which streetlights cast shadows, favouring whichever are nearest
 * the camera — those are the ones a facilitator standing in the scene would
 * actually notice a shadow (or its telltale absence) from. Cheap (a sort over
 * however many streetlights are on site), but still meant to be called from a
 * throttled spot in the render loop rather than every frame: toggling
 * `castShadow` makes three.js render (or stop rendering) that light's cube
 * shadow map, and doing that for six lights every single frame regardless of
 * whether the camera actually moved would burn the render budget this whole
 * scheme exists to protect.
 *
 * With `shadow.autoUpdate = false` (see `buildStreetlights`), a light's cube
 * map is otherwise never re-rendered on its own — so a light that's *staying*
 * a caster across this call keeps its existing map untouched (correct: the
 * static geometry around it hasn't moved, so nothing it occludes has
 * changed), and only a light newly *entering* the caster set gets
 * `shadow.needsUpdate = true`, for exactly one fresh render. This is what
 * actually fixed the reported night-time slowdown: previously every one of
 * up to six active streetlight shadow maps re-rendered on every single
 * frame (6 cube faces each, 60 times a second) for as long as it stayed
 * selected, purely because a `PointLight`'s shadow auto-updates by default —
 * a cost that only existed after dark, since daytime lights are `visible =
 * false` (see `applyNightLights`) and three.js skips an invisible object's
 * shadow pass entirely, which is exactly why the slowdown was night-only
 * even though `MAX_SHADOW_CASTERS` never changes with time of day. */
export function updateStreetlightShadows(build: StreetlightBuild, camera: THREE.Camera): void {
  const cameraPosition = camera.position;
  if (!CHEAP) {
    const lights = build.lights;
    const nearest = [...lights]
      .sort((a, b) => a.position.distanceToSquared(cameraPosition) - b.position.distanceToSquared(cameraPosition))
      .slice(0, MAX_SHADOW_CASTERS);
    const nearestSet = new Set(nearest);
    for (const light of lights) {
      const shouldCast = nearestSet.has(light);
      if (shouldCast && !light.castShadow) light.shadow.needsUpdate = true;
      light.castShadow = shouldCast;
    }
    return;
  }
  assignRealLights(build, camera);
}

const frustum = new THREE.Frustum();
const viewProjection = new THREE.Matrix4();
const reach = new THREE.Sphere();

/** Moves the real lights to the lamps that matter most for what's on
 * screen: those whose light can reach the camera's view (their range
 * overlaps the view frustum — lamps ahead, but also lamps just behind or
 * beside the camera, whose shadows stretch forward into view), nearest the
 * camera first, since nearby shadows are the large, noticeable ones. Spare
 * lights, if fewer lamps reach the view, go to the nearest others.
 *
 * A light already on a lamp that stays selected isn't moved (that would
 * needlessly re-render its shadow); the others take the newly selected
 * lamps. They all cast shadows. */
function assignRealLights(build: StreetlightBuild, camera: THREE.Camera): void {
  const { lights, lamps, assigned } = build;
  camera.updateMatrixWorld();
  viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(viewProjection);
  const ranked = lamps
    .map((lamp, index) => ({
      index,
      distance: lamp.distanceToSquared(camera.position),
      inView: frustum.intersectsSphere(reach.set(lamp, LIGHT_DISTANCE_M)),
    }))
    .sort((a, b) => Number(b.inView) - Number(a.inView) || a.distance - b.distance);
  const wanted = new Set(ranked.slice(0, lights.length).map((entry) => entry.index));

  const kept = new Set<number>();
  assigned.forEach((lamp, light) => {
    if (wanted.has(lamp)) kept.add(lamp);
    else assigned[light] = -1;
  });
  const newcomers = [...wanted].filter((lamp) => !kept.has(lamp));
  assigned.forEach((lamp, light) => {
    if (lamp !== -1) return;
    const next = newcomers.shift();
    if (next === undefined) return;
    assigned[light] = next;
    lights[light].position.copy(lamps[next]);
    lights[light].shadow.needsUpdate = true;
  });

  assigned.forEach((_, light) => {
    if (!lights[light].castShadow) lights[light].shadow.needsUpdate = true;
    lights[light].castShadow = true;
  });
  // Those lamps are lit by their real light; the simplified lighting skips
  // them so they don't light things twice.
  setRealLamps(new Set(assigned));
}

/** 0 (fully off) to 1 (fully on) — the inverse of `daylightFraction`, so
 * streetlights switch on right as the sun light fades, not before or after. */
function nightFactor(altitudeDeg: number): number {
  return 1 - daylightFraction(altitudeDeg);
}

/** Toggles both the ground illumination (the `PointLight`s) and the globes'
 * own glow. All globes share one material (see `buildStreetlights`), so
 * mutating its `emissiveIntensity` here lights up every lamp at once, which
 * is correct since they're all driven by the same global time of day anyway.
 * Without this, a working `PointLight` still leaves the lamp itself looking
 * off from a distance. */
export function applyNightLights(build: StreetlightBuild, materials: MaterialLibrary, altitudeDeg: number): void {
  const factor = nightFactor(altitudeDeg);
  for (const light of build.lights) {
    light.visible = factor > 0;
    light.intensity = LIGHT_INTENSITY * factor;
  }
  if (CHEAP) setLampIntensity(LIGHT_INTENSITY * factor);

  const globeMaterial = streetlightGlobe(materials);
  globeMaterial.emissive.setHex(LIGHT_COLOR);
  globeMaterial.emissiveIntensity = factor * 1.4;
}

/** The streetlights as a scene part: lit after dark (`applyNightLights`),
 * their real lights following the camera (`updateStreetlightShadows`). */
export const buildStreetlightPart: PartBuilder = ({ elements, anchor, materials, terrain }) => {
  const build = buildStreetlights(elements, anchor, materials, terrain);
  const group = new THREE.Group();
  group.name = "streetlights";
  if (build.poleMesh) group.add(build.poleMesh);
  if (build.globeMesh) group.add(build.globeMesh);
  for (const light of build.lights) group.add(light);
  return {
    object: group,
    setSun: (sun, library) => applyNightLights(build, library, sun.altitudeDeg),
    // A rebuild creates fresh lights, all starting castShadow=false, so the
    // viewer calls this right after the build too, not only once the camera
    // has moved a few metres.
    cameraMoved: build.lights.length > 0 ? (camera) => updateStreetlightShadows(build, camera) : undefined,
  };
};
