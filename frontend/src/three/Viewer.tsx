import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { CardSpec, DiscreteElement, InterventionDisplayMode, SceneResponse } from "../api/types";
import { buildScene, disposeScene, type BuiltScene } from "./SceneBuilder";
import { buildPlacards, disposePlacards, facePlacards, type Placards } from "./builders/placards";
import { tr, useLang } from "../i18n/lang";
import { Lighting } from "./Lighting";
import { MaterialLibrary } from "./materials";
import { terminateTreeWorkerPool } from "./workers/treeWorkerPool";
import type { SeasonState, SunPosition } from "./sun";
import { DEFAULT_FOV_DEG, LOOK_DISTANCE_M, MIN_CAMERA_HEIGHT_M, OVERVIEW_FOV_DEG, type CameraPose } from "./camera";
import { anchorFromPolygon, bearingToDirection, directionToBearing, toLocal, toLngLat } from "./geo";
import { WalkController, type Footprint } from "./walk";
import { FLAT_TERRAIN, intersectTerrain, type Terrain } from "./terrain";
import * as timeline from "../perf/timeline";
import { Crowd } from "./people/Crowd";
import { planCrowd, walkerCount, type StopTally } from "./people/plan";
import { buildWalkNetwork, type WalkNetwork } from "./people/network";
import { planWalkers } from "./people/walkers";
import { buildRoadNetwork, Traffic, type RoadNetwork } from "./people/traffic";
import type { CrowdActivity, LifeMode } from "./people/activity";
import { PerfRecorder, type PerfSummary } from "./perf";
import { OVERLAY_HEIGHT_M, ThermalOverlay } from "./thermalOverlay";
import { layerAt, summaryAt, valueAt, type ThermalField, type ThermalReading } from "../thermal/field";
import {
  crowdExposure,
  edgeWalkCosts,
  networkExposure,
  type CrowdExposure,
  type FeltSampler,
  type StopShortfall,
} from "./people/comfort";

/** Element types the walking network is built from (see people/network.ts). */
const WALK_NETWORK_TYPES = new Set<DiscreteElement["type"]>([
  "path",
  "crossing",
  "streetlight",
  "kiosk",
  "playground",
  "fitness_area",
  "pergola",
  "water_feature",
]);

/** Element types the road network is built from (see people/traffic.ts). */
const ROAD_NETWORK_TYPES = new Set<DiscreteElement["type"]>(["street", "crossing", "traffic_signal"]);

// The camera's far plane: this, or more on a site large enough to need it
// (see `applyBuilt`).
const MIN_CAMERA_FAR_M = 3000;

export interface ViewerHandle {
  /** Downloads the current frame as a PNG. */
  captureFrame: () => void;
  /** Frame timings since the last reset (see three/perf.ts), plus what's
   * in the scene right now. */
  readPerf: (reset: boolean) => PerfSummary & { people: number; dogs: number; cars: number };
  /** Slowly circles the camera (orbit mode only) — for measuring, since at
   * night camera movement is what triggers streetlight shadow updates. */
  setAutoRotate: (on: boolean) => void;
  /** Where the camera is and looks, now (or where it will be, before the
   * first build) — for carrying the view over to the 2D map. */
  readView: () => CameraPose | null;
  /** Moves the camera there, orbiting around the ground point at the centre
   * of the view — how the 2D map's framing is carried over (map/viewSync.ts).
   * Unlike `pose`, this is not a placed viewpoint. */
  showView: (view: CameraPose) => void;
  /** Back to the framing the view opened on, out of walking or wherever
   * the camera was moved — "Vista d'insieme". */
  showOverview: () => void;
}

interface ViewerProps {
  scene: SceneResponse | null;
  /** The ground's shape: nothing is built while it's null (not known yet). */
  terrain: Terrain | null;
  /** "simulated" builds the interventions into the scene; "cards" shows the
   * current situation with a standing placard per intervention instead;
   * "hidden" shows the current situation only. */
  mode: InterventionDisplayMode;
  /** For each placard's category colour, icon and label. */
  cards: CardSpec[];
  /** Fires when a placard is clicked. */
  onSelectIntervention?: (id: string) => void;
  /** Imperative actions for the surrounding view's own toolbar. */
  handleRef?: Ref<ViewerHandle>;
  /** False while the view is hidden behind another tab: the scene is still
   * kept (and rebuilt on model changes) but nothing is rendered. */
  active: boolean;
  sun: SunPosition;
  /** How full/coloured deciduous tree canopies are — derived from the sun's
   * `month`, not `SunPosition` itself (which only carries the resolved
   * direction/altitude/azimuth), so this is threaded through as its own
   * prop rather than recomputed here. Applied to the scene built, without
   * rebuilding it. */
  season: SeasonState;
  /** Eye-level viewpoint placed on the map. Null shows the overview instead. */
  pose: CameraPose | null;
  /** Fires as the 3D camera moves, so the plan view can track it. Throttled,
   * and deliberately *not* fed back in through `pose` — that would be a loop. */
  onViewChange?: (pose: CameraPose, mode: "orbit" | "walk") => void;
  /** Scenario year the scene was resolved at — only used to label exports. */
  t: number;
  /** How many people are around (time of day, season) — see people/activity.ts. */
  crowdActivity: CrowdActivity;
  /** People, dogs and cars hidden, frozen or moving. */
  lifeMode: LifeMode;
  /** Where to start, instead of the default overview — the 2D map's framing
   * when the view is first opened (see `ViewerHandle.showView`). */
  initialView?: CameraPose | null;
  /** The felt-temperature field at the hour shown, as a sheet over the site;
   * null hides it. */
  thermal?: { field: ThermalField; layer: Float32Array; stale: boolean } | null;
  /** Felt temperature under the pointer while the sheet is shown — or, while
   * walking, where the walker stands. Null off the field. */
  onThermalReading?: (reading: ThermalReading) => void;
  /** The felt-temperature field of the scene built, and the hour to read
   * it at: people react to it (where they stop, which way they walk) when
   * `react`, and are measured against it either way. Shown or not,
   * independently of `thermal`. */
  comfort?: { field: ThermalField; hour: number; react: boolean } | null;
  /** How the crowd fares in it, a few times a second while it changes;
   * null with no field or nobody around. */
  onCrowdExposure?: (exposure: CrowdExposure | null) => void;
}

/** The realistic 3D view.
 *
 * Owns its own WebGL context, separate from MapLibre's — two contexts is well
 * within any browser's budget and keeps the two renderers from having to agree
 * on anything but the model. The component stays mounted when its tab is
 * hidden, so `active` pauses the render loop rather than burning GPU behind
 * another view.
 */
export function Viewer({
  scene,
  terrain,
  mode,
  cards,
  onSelectIntervention,
  handleRef,
  active,
  sun,
  season,
  pose,
  t,
  onViewChange,
  crowdActivity,
  lifeMode,
  initialView = null,
  thermal = null,
  onThermalReading,
  comfort = null,
  onCrowdExposure,
}: ViewerProps) {
  // Only "simulated" changes the built geometry; "hidden" and "cards" share
  // the same current-situation build, so switching between those two only
  // toggles the placards and never pays for a full rebuild.
  const showInterventions = mode === "simulated";
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const composerRef = useRef<EffectComposer | null>(null);
  const threeSceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const lightingRef = useRef<Lighting | null>(null);
  const materialsRef = useRef<MaterialLibrary | null>(null);
  const builtRef = useRef<BuiltScene | null>(null);
  const placardsRef = useRef<Placards | null>(null);
  const crowdRef = useRef<Crowd | null>(null);
  const thermalOverlayRef = useRef<ThermalOverlay | null>(null);
  const thermalRef = useRef(thermal);
  thermalRef.current = thermal;
  const onThermalReadingRef = useRef(onThermalReading);
  onThermalReadingRef.current = onThermalReading;
  // What the crowd was last planned against: the elements actually built
  // (with or without interventions) and the build's anchor/footprints.
  const crowdSceneRef = useRef<{
    elements: DiscreteElement[];
    built: BuiltScene;
    /** The site's boundary, as a ring in the local frame. */
    site: Footprint;
    network: WalkNetwork;
    roads: RoadNetwork;
  } | null>(null);
  const trafficRef = useRef<Traffic | null>(null);
  // The walking network only changes when paths, crossings, lights or
  // destinations do — not on every rebuild (a year change rebuilds the whole
  // scene) — and a new network restarts every walker, so it's reused while
  // its inputs are unchanged.
  const networkRef = useRef<{ key: string; network: WalkNetwork } | null>(null);
  const roadsRef = useRef<{ key: string; roads: RoadNetwork } | null>(null);
  const crowdActivityRef = useRef(crowdActivity);
  crowdActivityRef.current = crowdActivity;
  const comfortRef = useRef(comfort);
  comfortRef.current = comfort;
  const onCrowdExposureRef = useRef(onCrowdExposure);
  onCrowdExposureRef.current = onCrowdExposure;
  // The field the crowd was last planned against, at its hour: null off the
  // field (for measuring, unlike the planning's sampler).
  const comfortFeltRef = useRef<FeltSampler | null>(null);
  const shortfallRef = useRef<StopShortfall | null>(null);
  const lifeModeRef = useRef(lifeMode);
  lifeModeRef.current = lifeMode;
  const perfRef = useRef(new PerfRecorder());
  // Shared between the mount effect's render loop (which throttles re-picking
  // the nearest shadow-casting streetlights) and the scene-rebuild effect
  // (which needs to force an immediate re-pick against the *new* light
  // objects a rebuild creates — see the reset in the scene-build effect
  // below).
  const shadowCasterStateRef = useRef({
    time: 0,
    position: new THREE.Vector3(Infinity, Infinity, Infinity),
    direction: new THREE.Vector3(),
  });
  const walkRef = useRef<WalkController | null>(null);
  const framedRef = useRef(false);
  // A view asked for (showView) before the first build could place it.
  const pendingViewRef = useRef<CameraPose | null>(initialView);
  const [walking, setWalking] = useState(false);
  // Read inside the animation loop, which is created once and must not close
  // over a stale prop.
  const sunRef = useRef(sun);
  sunRef.current = sun;
  const seasonRef = useRef(season);
  seasonRef.current = season;
  const activeRef = useRef(active);
  activeRef.current = active;
  const poseRef = useRef(pose);
  poseRef.current = pose;
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const onSelectInterventionRef = useRef(onSelectIntervention);
  onSelectInterventionRef.current = onSelectIntervention;
  // Which pose object has already been moved to, so a scene rebuild doesn't
  // yank the camera back to the placed viewpoint after the user has walked.
  const appliedPoseRef = useRef<CameraPose | null>(null);

  /** Reads refs only, so it's safe from the build's async callback. */
  function replanCrowd() {
    const input = crowdSceneRef.current;
    if (!input || !crowdRef.current) return;
    const activity = crowdActivityRef.current;
    const comfort = comfortRef.current;
    let felt: FeltSampler | null = null;
    comfortFeltRef.current = null;
    if (comfort) {
      const layer = layerAt(comfort.field, comfort.hour);
      const onField: FeltSampler = (x, z) => valueAt(comfort.field, layer, x, -z);
      comfortFeltRef.current = onField;
      // Beyond the site the field says nothing, though walkers' routes run
      // through the streets around it: there, the site's average. Counted
      // as comfortable instead, routes would leave the square for streets
      // just as hot.
      const elsewhere = summaryAt(comfort.field.meanFelt, comfort.hour);
      if (comfort.react) felt = (x, z) => onField(x, z) ?? elsewhere;
    }
    // Who the temperature keeps from stopping, and from walking through:
    // they go elsewhere.
    const onField = comfortFeltRef.current;
    const tally: StopTally | null = felt ? { wouldStop: 0, stop: 0, stressed: 0 } : null;
    const placed = planCrowd(
      input.elements,
      input.built.anchor,
      input.built.footprints,
      input.site,
      activity,
      felt,
      tally
    );
    crowdRef.current.setPlan(placed);
    let walkers = walkerCount(activity);
    shortfallRef.current = null;
    if (tally && onField) {
      const { pass } = networkExposure(input.network, onField);
      walkers = Math.round(walkers * pass);
      shortfallRef.current = { wouldStop: tally.wouldStop, stop: tally.stop, pass };
    }
    crowdRef.current.setWalkers(planWalkers(walkers, input.network), input.network, {
      dark: activity.dark,
      walkCosts: felt ? edgeWalkCosts(input.network, felt) : null,
      felt,
    });
    trafficRef.current?.setNetwork(input.roads);
    trafficRef.current?.setActivity(activity.traffic, activity.dark);
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // logarithmicDepthBuffer: the camera's near/far is 0.1-3000m (a 30000:1
    // ratio, needed to get from walk-mode close-ups to the sky sphere in one
    // camera), and a standard depth buffer concentrates almost all its
    // precision within the first few metres of that range. Distant opaque
    // geometry (a building's roofline near the horizon, the far edge of the
    // ground plane) then rounds to essentially the same depth as the sky —
    // which is deliberately pinned to exactly the far plane (see Sky.js's
    // `gl_Position.z = gl_Position.w` and the comment on it in Lighting.ts)
    // — so the two tie, and which one wins the depth test stops being
    // reliable. That's the actual mechanism behind "the sun is visible
    // through/above a building that should block it": confirmed by sampling
    // the same pixel column at noon (solid building) vs. at dawn (sun disc,
    // no building edge at all in the colour profile) from an identical
    // camera pose. A logarithmic depth buffer distributes precision evenly
    // across the whole range instead, which is the standard fix for exactly
    // this "near-field detail and a far horizon in one camera" case.
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      logarithmicDepthBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Reset once per frame (below) rather than per render call, so the
    // counts cover every pass of a frame, shadow maps included.
    renderer.info.autoReset = false;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // The Preetham sky outputs physically large radiance values; ~0.5 is the
    // exposure three's own sky example settles on to bring them into range.
    renderer.toneMappingExposure = 0.5;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const threeScene = new THREE.Scene();
    threeSceneRef.current = threeScene;

    const camera = new THREE.PerspectiveCamera(OVERVIEW_FOV_DEG, 1, 0.1, MIN_CAMERA_FAR_M);
    camera.position.set(120, 90, 120);
    cameraRef.current = camera;

    // EffectComposer renders through an offscreen target rather than straight
    // to the canvas, so the renderer's own MSAA (from `antialias: true` above)
    // never kicks in unless the target requests samples itself.
    const composerTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    const composer = new EffectComposer(renderer, composerTarget);
    composer.addPass(new RenderPass(threeScene, camera));
    // GTAO (contact AO) is disabled for now: screenshots showed a distinct
    // bright "halo" ring of grass right at the base of thin objects (bench
    // legs, tree trunks) before their real cast shadow began — a known
    // SSAO/GTAO artifact at object-ground contact points, and the one new
    // lighting mechanism introduced this session that had *not* yet been
    // tested as a suspect for the repeated "objects float above the ground"
    // reports, after two other fixes (shadow normalBias, cover-height
    // stacking) didn't resolve it. Pulled out as a clean isolation test
    // rather than another blind parameter tweak; re-add (with a smaller
    // radius — 0.4m was likely oversized for 6-8cm furniture) only once
    // confirmed this was actually the cause.
    // No bloom: a naive threshold-based UnrealBloomPass reads pre-tonemap
    // linear radiance, and the Preetham sky (see Lighting.ts) is physically
    // huge near the sun — thousands of units, the reason that file needs a
    // 0.5 exposure just to bring it into range. Any threshold low enough to
    // catch "the sun" catches the whole sky dome instead, which blooms into
    // the fog-like whiteout the moment the camera looks sunward. Catching
    // only genuine point sources (sun disc, streetlight heads) needs
    // selective/layer-based bloom (a second masked scene render), not a
    // whole-image threshold — worth adding later only as its own pass, not
    // bundled in here.
    // Composer passes run in linear HDR; this is what actually applies the
    // renderer's ACES tone mapping + sRGB output, same as a direct
    // renderer.render() call does implicitly when drawing straight to canvas.
    composer.addPass(new OutputPass());
    composerRef.current = composer;

    // The 2D map's gestures (MapControls): left drag / one finger pans, right
    // drag or Ctrl + drag rotates and tilts, wheel / pinch zooms — so
    // switching tab doesn't swap what the buttons do.
    const controls = new MapControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.02; // never orbit under the ground
    // Pan across the ground plane rather than across the screen. Screen-space
    // panning (the default) tilts with the camera, so panning while looking
    // down drags the orbit target below y=0 and the camera follows it under
    // the pavement.
    controls.screenSpacePanning = false;
    controls.minDistance = 1;
    controlsRef.current = controls;

    const walk = new WalkController(camera, renderer.domElement);
    walk.controls.addEventListener("lock", () => {
      controls.enabled = false;
      walk.attach();
      setWalking(true);
    });
    walk.controls.addEventListener("unlock", () => {
      walk.detach();
      controls.enabled = true;
      hereReported = undefined;
      onThermalReadingRef.current?.(null);
      // Leave the orbit target where the walker was looking, so exiting the
      // walk doesn't teleport the view back to wherever it started.
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      // When looking down, put the target where the gaze actually meets the
      // ground rather than a fixed distance ahead — that would bury it under
      // the pavement, and the floor clamp would then jerk the view on the next
      // frame. This way the direction is preserved exactly and you end up
      // orbiting the spot you were just looking at.
      const terrain = builtRef.current?.terrain ?? FLAT_TERRAIN;
      const ground = terrain.heightAt(camera.position.x, camera.position.z);
      let distance = LOOK_DISTANCE_M;
      if (forward.y < -1e-3) {
        distance = Math.min(distance, (camera.position.y - ground - MIN_CAMERA_HEIGHT_M) / -forward.y);
      }
      // Floor matches controls.minDistance. Kept low deliberately: a larger
      // one would overshoot the ground on a steep downward look, and the
      // target clamp below would then swing the view a couple of degrees.
      controls.target
        .copy(camera.position)
        .addScaledVector(forward, Math.max(distance, controls.minDistance));
      clampToGround(terrain, camera, controls);
      controls.update();
      setWalking(false);
    });
    walkRef.current = walk;

    const lighting = new Lighting(threeScene, renderer);
    lighting.setSun(sunRef.current);
    lightingRef.current = lighting;

    materialsRef.current = new MaterialLibrary();

    // Outside the rebuilt scene group, so people survive (and are only
    // incrementally updated by) rebuilds.
    const crowd = new Crowd();
    crowd.group.visible = lifeModeRef.current !== "off";
    threeScene.add(crowd.group);
    crowdRef.current = crowd;
    const traffic = new Traffic();
    traffic.group.visible = lifeModeRef.current !== "off";
    traffic.setFrozen(lifeModeRef.current !== "live");
    threeScene.add(traffic.group);
    trafficRef.current = traffic;
    const thermalOverlay = new ThermalOverlay(renderer.toneMappingExposure);
    threeScene.add(thermalOverlay.mesh);
    thermalOverlayRef.current = thermalOverlay;

    const resize = () => {
      const { clientWidth, clientHeight } = container;
      if (clientWidth === 0 || clientHeight === 0) return;
      // updateStyle must stay on (the default): with it off, three sizes the
      // canvas *buffer* to clientWidth x devicePixelRatio but leaves the CSS
      // size unset, so on a retina display the element lays out at twice the
      // panel's width and spills over the controls beneath it.
      renderer.setSize(clientWidth, clientHeight);
      composer.setSize(clientWidth, clientHeight);
      composer.setPixelRatio(renderer.getPixelRatio());
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    // Placard picking. A click is a press and release without dragging —
    // anything more is the facilitator orbiting, which must not also select
    // whatever card happened to be under the pointer at release.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const CLICK_MAX_MOVE_PX = 5;
    let pressedAt: { x: number; y: number } | null = null;
    const placardAt = (event: PointerEvent): string | null => {
      const placards = placardsRef.current;
      if (!placards || placards.panels.length === 0 || walk.isLocked) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(placards.panels, false)[0];
      return hit ? (hit.object.userData.interventionId as string) : null;
    };
    const handlePointerDown = (event: PointerEvent) => {
      pressedAt = { x: event.clientX, y: event.clientY };
    };
    const handlePointerUp = (event: PointerEvent) => {
      const start = pressedAt;
      pressedAt = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_MAX_MOVE_PX) return;
      const id = placardAt(event);
      if (id) onSelectInterventionRef.current?.(id);
    };
    // Where the pointer meets the felt-temperature sheet.
    const sheet = new THREE.Plane(new THREE.Vector3(0, 1, 0), -OVERLAY_HEIGHT_M);
    const onSheet = new THREE.Vector3();
    const reportThermal = (event: PointerEvent) => {
      const report = onThermalReadingRef.current;
      const shown = thermalRef.current;
      // While walking, the reading is where the walker stands (see the
      // render loop), not under a pointer that is locked anyway.
      if (!report || walk.isLocked) return;
      if (!shown) return report(null);
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const terrain = builtRef.current?.terrain ?? FLAT_TERRAIN;
      let hit: THREE.Vector3 | null;
      if (terrain.flat) {
        hit = raycaster.ray.intersectPlane(sheet, onSheet);
      } else {
        // The sheet follows the ground: meeting it is meeting the ground
        // from OVERLAY_HEIGHT_M lower.
        const { origin, direction } = raycaster.ray;
        const ground = intersectTerrain(terrain, { x: origin.x, y: origin.y - OVERLAY_HEIGHT_M, z: origin.z }, direction);
        hit = ground ? onSheet.set(ground.x, ground.y + OVERLAY_HEIGHT_M, ground.z) : null;
      }
      const celsius = hit ? valueAt(shown.field, shown.layer, onSheet.x, -onSheet.z) : null;
      report(celsius === null ? null : { celsius, where: "pointer" });
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (event.buttons !== 0) return;
      renderer.domElement.style.cursor = placardAt(event) ? "pointer" : "";
      reportThermal(event);
    };
    const handlePointerLeave = () => {
      if (!walk.isLocked) onThermalReadingRef.current?.(null);
    };
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);

    // Live view reporting, rate-limited on both time and movement: the render
    // loop runs at 60fps and each report redraws a GeoJSON source on the map,
    // which is far more than a plan view needs to feel like it's keeping up.
    const REPORT_INTERVAL_MS = 100;
    const REPORT_MIN_MOVE_M = 0.25;
    const REPORT_MIN_TURN_DEG = 1;
    const forward = new THREE.Vector3();
    const reportedAt = new THREE.Vector3(Infinity, Infinity, Infinity);
    let reportedBearing = Infinity;
    let reportedTime = 0;

    // Re-picking the nearest N shadow-casting streetlights (the urban pack's
    // `cameraMoved` part hook) touches every light on site and, for
    // whichever ones flip on, makes the renderer produce a new cube shadow
    // map that frame — worth throttling the same way view reporting is
    // above, on both time and movement, rather than doing it every frame.
    const SHADOW_CASTER_INTERVAL_MS = 500;
    const SHADOW_CASTER_MIN_MOVE_M = 3;
    const SHADOW_CASTER_MIN_TURN_RAD = (15 * Math.PI) / 180;
    const casterDirection = new THREE.Vector3();

    const updateShadowCasters = (now: number) => {
      // Runs every frame: no array built here, just a check.
      const parts = builtRef.current?.parts;
      if (!parts || !parts.some((part) => part.cameraMoved)) return;
      const state = shadowCasterStateRef.current;
      if (now - state.time < SHADOW_CASTER_INTERVAL_MS) return;
      // Which lamps get real lights depends on what's in view too (see the
      // urban pack's streetlights.ts), so turning counts as well as moving.
      camera.getWorldDirection(casterDirection);
      const moved = camera.position.distanceTo(state.position) >= SHADOW_CASTER_MIN_MOVE_M;
      const turned = casterDirection.angleTo(state.direction) >= SHADOW_CASTER_MIN_TURN_RAD;
      if (!moved && !turned) return;
      state.time = now;
      state.position.copy(camera.position);
      state.direction.copy(casterDirection);
      for (const part of parts) part.cameraMoved?.(camera);
    };

    const reportView = (now: number) => {
      const notify = onViewChangeRef.current;
      const built = builtRef.current;
      if (!notify || !built) return;
      if (now - reportedTime < REPORT_INTERVAL_MS) return;

      camera.getWorldDirection(forward);
      const bearing = directionToBearing(forward.x, forward.z);
      const turned = Math.abs(((bearing - reportedBearing + 540) % 360) - 180);
      if (camera.position.distanceTo(reportedAt) < REPORT_MIN_MOVE_M && turned < REPORT_MIN_TURN_DEG) {
        return;
      }

      reportedTime = now;
      reportedAt.copy(camera.position);
      reportedBearing = bearing;

      notify(cameraView(camera, built), walk.isLocked ? "walk" : "orbit");
    };

    // While walking: the felt temperature where the walker stands, checked a
    // few times a second and reported when it changes.
    const HERE_INTERVAL_MS = 200;
    let hereCheckedAt = 0;
    let hereReported: number | null | undefined;
    const reportHere = (now: number) => {
      if (now - hereCheckedAt < HERE_INTERVAL_MS) return;
      hereCheckedAt = now;
      const shown = thermalRef.current;
      const raw = shown ? valueAt(shown.field, shown.layer, camera.position.x, -camera.position.z) : null;
      const celsius = raw === null ? null : Math.round(raw * 10) / 10;
      if (celsius === hereReported) return;
      hereReported = celsius;
      onThermalReadingRef.current?.(celsius === null ? null : { celsius, where: "here" });
    };

    // How the crowd fares: once a second (walkers move), reported when the
    // figures change.
    const EXPOSURE_INTERVAL_MS = 1000;
    let exposureCheckedAt = 0;
    let exposureReported = "";
    const reportExposure = (now: number) => {
      if (now - exposureCheckedAt < EXPOSURE_INTERVAL_MS) return;
      exposureCheckedAt = now;
      const felt = comfortFeltRef.current;
      const exposure =
        felt && lifeModeRef.current !== "off" && crowdRef.current
          ? crowdExposure(crowdRef.current.positions(), felt, shortfallRef.current)
          : null;
      const key = JSON.stringify(exposure);
      if (key === exposureReported) return;
      exposureReported = key;
      onCrowdExposureRef.current?.(exposure?.all.people ? exposure : null);
    };

    let frame = 0;
    const clock = new THREE.Clock();
    let lastFrameAt = 0;
    const animate = (now = performance.now()) => {
      frame = requestAnimationFrame(animate);
      // Read even when paused, so resuming doesn't hand the walk controller
      // the whole hidden interval as one frame's worth of movement.
      const delta = clock.getDelta();
      const interval = lastFrameAt > 0 ? now - lastFrameAt : 0;
      lastFrameAt = now;
      if (!activeRef.current) return;
      renderer.info.reset();
      if (walk.isLocked) {
        // Walk mode pins the eye to a fixed height every step, so it can't
        // sink on its own.
        walk.update(delta);
      } else {
        controls.update();
        // Belt and braces on top of maxPolarAngle and ground-plane panning:
        // zoom, damping overshoot and a target dragged downhill can each still
        // put the camera under the pavement, and there is no combination of
        // OrbitControls settings that rules all of them out.
        clampToGround(builtRef.current?.terrain ?? FLAT_TERRAIN, camera, controls);
      }
      lighting.update(clock.elapsedTime);
      updateShadowCasters(performance.now());
      for (const part of builtRef.current?.parts ?? []) part.frame?.(camera, clock.elapsedTime);
      if (placardsRef.current) facePlacards(placardsRef.current, camera);
      const ground = builtRef.current?.terrain.heightAt(camera.position.x, camera.position.z) ?? 0;
      thermalOverlay.setViewHeight(camera.position.y - ground);
      if (walk.isLocked) reportHere(performance.now());
      reportExposure(performance.now());
      // "still" doesn't advance anything; it only settles figures added
      // since the last frame (a replan) into their pose. "off" does neither.
      const simStart = performance.now();
      if (lifeModeRef.current === "live") {
        crowd.update(delta);
        traffic.update(delta, crowd.walkerPositions());
      } else if (lifeModeRef.current === "still") {
        crowd.settle();
        traffic.settle();
      }
      const renderStart = performance.now();
      composer.render();
      const renderEnd = performance.now();
      // A frame after a pause (tab hidden, view switched away) isn't
      // representative; slow frames on a weak machine are, so the cut-off
      // is generous.
      if (interval > 0 && interval < 10000) {
        perfRef.current.push({
          interval,
          sim: renderStart - simStart,
          render: renderEnd - renderStart,
          calls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
        });
      }
      reportView(performance.now());
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      thermalOverlay.dispose();
      thermalOverlayRef.current = null;
      if (placardsRef.current) disposePlacards(placardsRef.current);
      placardsRef.current = null;
      crowd.dispose();
      crowdRef.current = null;
      traffic.dispose();
      trafficRef.current = null;
      crowdSceneRef.current = null;
      controls.dispose();
      walk.dispose();
      if (builtRef.current) disposeScene(builtRef.current);
      lighting.dispose();
      materialsRef.current?.dispose();
      terminateTreeWorkerPool();
      composer.dispose();
      composerRef.current = null;
      threeSceneRef.current = null;
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      builtRef.current = null;
      framedRef.current = false;
    };
  }, []);

  // One build at a time: a full build (trees above all) takes a while and a
  // lot of memory, and changing the date back and forth while one is running
  // used to start another next to it, and another — enough to crash the
  // tab. A change during a build is only recorded; when the build is done,
  // the latest one asked for is built (and a build already out of date is
  // dropped rather than shown).
  const buildInputsRef = useRef<{ scene: SceneResponse; terrain: Terrain; showInterventions: boolean } | null>(null);
  const buildingRef = useRef(false);

  function runBuild() {
    const threeScene = threeSceneRef.current;
    const materials = materialsRef.current;
    const lighting = lightingRef.current;
    const inputs = buildInputsRef.current;
    if (!inputs || !threeScene || !materials || !lighting || buildingRef.current) return;
    buildingRef.current = true;
    buildScene(inputs.scene, materials, inputs.showInterventions, inputs.terrain).then((built) => {
      buildingRef.current = false;
      // Unmounted meanwhile (the mount effect's cleanup clears the scene ref).
      if (threeSceneRef.current !== threeScene) {
        disposeScene(built);
        // A remount (React's development double mount) has its own scene
        // waiting for a build, if it's there.
        runBuild();
        return;
      }
      if (buildInputsRef.current !== inputs) {
        disposeScene(built);
        runBuild();
        return;
      }
      applyBuilt(built, inputs.scene, inputs.showInterventions, threeScene, materials, lighting);
      timeline.end("build");
    }).catch((error) => {
      buildingRef.current = false;
      timeline.end("build");
      console.error("Could not build the 3D scene", error);
    });
  }

  function applyBuilt(
    built: BuiltScene,
    scene: SceneResponse,
    showInterventions: boolean,
    threeScene: THREE.Scene,
    materials: MaterialLibrary,
    lighting: Lighting
  ) {
    if (builtRef.current) {
      threeScene.remove(builtRef.current.group);
      disposeScene(builtRef.current);
    }
    threeScene.add(built.group);
    builtRef.current = built;
    built.applySeason(seasonRef.current);
    thermalOverlayRef.current?.setTerrain(built.terrain);
    thermalOverlayRef.current?.set(thermalRef.current?.field ?? null, thermalRef.current?.layer ?? null, thermalRef.current?.stale);
    const crowdElements = showInterventions ? scene.elements : scene.elements.filter((e) => e.source === "baseline");
    const networkKey = JSON.stringify([
      scene.site_boundary,
      crowdElements.filter((e) => WALK_NETWORK_TYPES.has(e.type)).map((e) => [e.type, e.geometry]),
    ]);
    if (networkRef.current?.key !== networkKey) {
      networkRef.current = {
        key: networkKey,
        network: buildWalkNetwork(crowdElements, built.anchor, scene.site_boundary),
      };
    }
    const roadsKey = JSON.stringify([
      scene.site_boundary,
      crowdElements.filter((e) => ROAD_NETWORK_TYPES.has(e.type)).map((e) => [e.type, e.geometry, e.properties]),
    ]);
    if (roadsRef.current?.key !== roadsKey) {
      roadsRef.current = { key: roadsKey, roads: buildRoadNetwork(crowdElements, built.anchor, scene.site_boundary) };
    }
    // Before replanning: the figures, cars and traffic lights are placed on it.
    if (crowdRef.current) crowdRef.current.terrain = built.terrain;
    if (trafficRef.current) trafficRef.current.terrain = built.terrain;
    crowdSceneRef.current = {
      elements: crowdElements,
      built,
      site: (scene.site_boundary.coordinates[0] ?? []).flatMap(([lng, lat]) => toLocal(built.anchor, lng, lat)),
      network: networkRef.current.network,
      roads: roadsRef.current.roads,
    };
    replanCrowd();
    // fitTo moves the shadow camera's centre, so the sun has to be re-placed
    // relative to it afterwards.
    lighting.fitTo(built.bounds, [built.terrain.minHeight, built.terrain.maxHeight]);
    // Far enough to see the whole site from anywhere around it, however
    // large: Piazza Dante's is a few hundred metres across, a valley's
    // kilometres.
    if (cameraRef.current) {
      const { minX, maxX, minZ, maxZ } = built.bounds;
      const far = Math.max(MIN_CAMERA_FAR_M, 2 * Math.hypot(maxX - minX, maxZ - minZ, built.terrain.maxHeight));
      if (cameraRef.current.far !== far) {
        cameraRef.current.far = far;
        cameraRef.current.updateProjectionMatrix();
      }
    }
    lighting.setSun(sunRef.current);
    // A rebuild's fresh parts start with no sun (e.g. the water's
    // placeholder sun direction, a streetlight off at night): without
    // this they'd show wrong until the sun next changes.
    for (const part of built.parts) part.setSun?.(sunRef.current, materials);
    // Facade materials are cached/shared by colour (see materials.ts's
    // facade()), not rebuilt per scene — but a rebuild can still be the
    // first time a given colour's material gets created, so this has to
    // run here too, not just from the sun-change effect below.
    materials.applyNightWindows(sunRef.current.altitudeDeg);
    // A rebuild's parts that follow the camera (the urban pack's
    // streetlights, whose fresh lights all start castShadow=false) are told
    // where it is now — without this the render loop's throttle (see
    // updateShadowCasters) could wait up to SHADOW_CASTER_MIN_MOVE_M of
    // camera movement, leaving newly-placed or newly-loaded streetlights
    // shadowless until the facilitator happens to walk a few metres.
    if (cameraRef.current) {
      for (const part of built.parts) part.cameraMoved?.(cameraRef.current);
      shadowCasterStateRef.current.time = performance.now();
      shadowCasterStateRef.current.position.copy(cameraRef.current.position);
      cameraRef.current.getWorldDirection(shadowCasterStateRef.current.direction);
    }

    // Frame the site once, on the first successful build — and only when no
    // viewpoint was placed, since a pose is an explicit instruction about
    // where to stand. Re-framing on every edit would yank the view away from
    // wherever the facilitator had put it.
    if (pendingViewRef.current) {
      showViewAt(built, cameraRef.current, controlsRef.current, pendingViewRef.current);
      pendingViewRef.current = null;
      framedRef.current = true;
      appliedPoseRef.current = poseRef.current;
    }
    if (!framedRef.current && !poseRef.current) {
      frameSite(built, cameraRef.current, controlsRef.current);
      framedRef.current = true;
    }
    // A pose set before this build finished had no anchor to resolve against
    // yet, so apply it now that there is one. Guarded on identity: without
    // that, every edit to the model would teleport the camera back to the
    // placed viewpoint, undoing wherever the facilitator had walked to.
    if (poseRef.current && appliedPoseRef.current !== poseRef.current) {
      applyPose(built, cameraRef.current, controlsRef.current, poseRef.current);
      appliedPoseRef.current = poseRef.current;
    }
    walkRef.current?.setCollision(built.footprints, built.bounds, built.terrain);
}

  useEffect(() => {
    if (!scene || !terrain) return;
    buildInputsRef.current = { scene, terrain, showInterventions };
    // Pending until a build of the latest inputs is in place (one already
    // under way for older inputs keeps it pending and starts another).
    if (!timeline.isPending("build")) timeline.begin("build");
    runBuild();
  }, [scene, terrain, showInterventions]);

  // The date only changes how the trees look (see BuiltScene.applySeason):
  // no rebuild.
  useEffect(() => {
    builtRef.current?.applySeason(season);
  }, [season]);

  useEffect(() => {
    replanCrowd();
  }, [crowdActivity.level, crowdActivity.traffic, crowdActivity.dark, comfort]);

  useEffect(() => {
    // Not before the landscape is there: a coloured sheet over an empty
    // scene reads as something wrong. The build shows it once done.
    const shown = builtRef.current ? thermal : null;
    thermalOverlayRef.current?.set(shown?.field ?? null, shown?.layer ?? null, shown?.stale);
    if (!thermal) onThermalReadingRef.current?.(null);
  }, [thermal]);

  useEffect(() => {
    if (crowdRef.current) crowdRef.current.group.visible = lifeMode !== "off";
    if (trafficRef.current) {
      trafficRef.current.group.visible = lifeMode !== "off";
      trafficRef.current.setFrozen(lifeMode !== "live");
    }
  }, [lifeMode]);

  useEffect(() => {
    lightingRef.current?.setSun(sun);
    if (builtRef.current && materialsRef.current) {
      for (const part of builtRef.current.parts) part.setSun?.(sun, materialsRef.current);
      materialsRef.current.applyNightWindows(sun.altitudeDeg);
    }
  }, [sun]);

  useEffect(() => {
    if (!builtRef.current) return;
    if (!pose) {
      // Cleared viewpoint ("Torna alla vista d'insieme"): back to the same
      // framing the view opened on.
      if (appliedPoseRef.current) frameSite(builtRef.current, cameraRef.current, controlsRef.current);
      appliedPoseRef.current = null;
      return;
    }
    applyPose(builtRef.current, cameraRef.current, controlsRef.current, pose);
    appliedPoseRef.current = pose;
  }, [pose]);

  // Placards live outside the main build (see `showInterventions` above), so
  // toggling "Carte proposte" on and off costs a handful of textured quads,
  // not a whole scene rebuild. Their text is drawn in the current language,
  // hence `lang` among the dependencies.
  const lang = useLang();
  useEffect(() => {
    const threeScene = threeSceneRef.current;
    if (!threeScene) return;
    if (placardsRef.current) {
      threeScene.remove(placardsRef.current.group);
      disposePlacards(placardsRef.current);
      placardsRef.current = null;
    }
    if (!scene || !terrain || mode !== "cards") return;
    const placards = buildPlacards(scene.interventions, cards, anchorFromPolygon(scene.site_boundary), terrain, scene.t);
    threeScene.add(placards.group);
    placardsRef.current = placards;
  }, [scene, terrain, cards, mode, lang]);

  useImperativeHandle(handleRef, () => ({
    captureFrame,
    readPerf: (reset: boolean) => ({
      ...perfRef.current.summarize(reset),
      // Hidden figures are still planned (so showing them is instant), but
      // they aren't drawn: count them as absent.
      ...(lifeModeRef.current !== "off" && crowdRef.current ? crowdRef.current.counts() : { people: 0, dogs: 0 }),
      cars: lifeModeRef.current !== "off" ? (trafficRef.current?.carCount ?? 0) : 0,
    }),
    readView: () => {
      const camera = cameraRef.current;
      const built = builtRef.current;
      if (!built || !camera) return pendingViewRef.current;
      return cameraView(camera, built);
    },
    showView: (view: CameraPose) => {
      const built = builtRef.current;
      if (!built) {
        pendingViewRef.current = view;
        return;
      }
      walkRef.current?.controls.unlock();
      showViewAt(built, cameraRef.current, controlsRef.current, view);
    },
    showOverview: () => {
      walkRef.current?.controls.unlock();
      if (builtRef.current) frameSite(builtRef.current, cameraRef.current, controlsRef.current);
      // The cleared pose that follows has nothing left to undo.
      appliedPoseRef.current = null;
    },
    setAutoRotate: (on: boolean) => {
      const controls = controlsRef.current;
      if (!controls) return;
      controls.autoRotate = on;
      controls.autoRotateSpeed = 1.5;
    },
  }));

  function captureFrame() {
    const renderer = rendererRef.current;
    const composer = composerRef.current;
    if (!renderer || !composer) return;

    // Re-render immediately before reading the buffer: the drawing buffer is
    // not preserved between frames, so whatever the last animation frame left
    // there may already have been cleared.
    composer.render();
    renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${(scene?.site_id ?? "view").replaceAll("_", "-")}-t${t}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.png`;
      link.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  function startWalk() {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!controls || !camera || !walkRef.current) return;
    walkRef.current.lock(controls.target);
    // The browser grants the pointer lock a few frames later, and until then
    // the orbit controls keep turning the camera to their target — on the
    // ground, from the overview. Moved straight ahead of the walker, just
    // low enough for maxPolarAngle not to lift the camera, it keeps the view
    // level (and stays sensible if the lock is refused).
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    controls.target.copy(camera.position).addScaledVector(forward, LOOK_DISTANCE_M);
    controls.target.y -= LOOK_DISTANCE_M * Math.tan(0.03);
    controls.update();
  }

  return (
    <div className="viewer-stage">
      <div ref={containerRef} className="viewer-canvas" />
      {walking ? (
        <div className="viewer-walk-hint">
          {tr(
            "WASD o frecce per muoverti · Shift per correre · Esc per uscire",
            "WASD or arrows to move · Shift to run · Esc to exit"
          )}
        </div>
      ) : (
        <button
          type="button"
          className="viewer-walk-button"
          onClick={startWalk}
        >
          {tr("Cammina nello spazio", "Walk through the space")}
        </button>
      )}
    </div>
  );
}

/** Keeps the orbit camera and its target off the ground. Belt and braces
 * on top of maxPolarAngle and ground-plane panning: zoom, damping overshoot
 * and a target dragged downhill can each still put the camera under the
 * ground, and there is no combination of OrbitControls settings that rules
 * all of them out. */
function clampToGround(terrain: Terrain, camera: THREE.PerspectiveCamera, controls: OrbitControls): void {
  const targetGround = terrain.heightAt(controls.target.x, controls.target.z);
  if (controls.target.y < targetGround) controls.target.y = targetGround;
  const cameraGround = terrain.heightAt(camera.position.x, camera.position.z) + MIN_CAMERA_HEIGHT_M;
  if (camera.position.y < cameraGround) camera.position.y = cameraGround;
}

/** Puts the camera at a placed viewpoint, looking along its bearing. */
function applyPose(
  built: BuiltScene | null,
  camera: THREE.PerspectiveCamera | null,
  controls: OrbitControls | null,
  pose: CameraPose | null
): void {
  if (!built || !camera || !controls || !pose) return;

  const [x, z] = toLocal(built.anchor, pose.lng, pose.lat);
  const [dx, dz] = bearingToDirection(pose.bearingDeg);
  const pitch = (pose.pitchDeg * Math.PI) / 180;

  const eye = built.terrain.heightAt(x, z) + Math.max(pose.eyeHeight, MIN_CAMERA_HEIGHT_M);
  camera.fov = pose.fovDeg;
  camera.position.set(x, eye, z);
  camera.updateProjectionMatrix();
  // Orbiting around a point ahead of the viewer, rather than around the whole
  // site, keeps "look around from where I'm standing" the natural gesture.
  const [tx, tz] = [x + dx * LOOK_DISTANCE_M, z + dz * LOOK_DISTANCE_M];
  controls.target.set(tx, Math.max(built.terrain.heightAt(tx, tz), eye + Math.tan(pitch) * LOOK_DISTANCE_M), tz);
  controls.update();
}

/** The camera's current position and direction, as a pose: its height is
 * above the ground under it. */
function cameraView(camera: THREE.PerspectiveCamera, built: BuiltScene): CameraPose {
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const [lng, lat] = toLngLat(built.anchor, camera.position.x, camera.position.z);
  return {
    lng,
    lat,
    eyeHeight: camera.position.y - built.terrain.heightAt(camera.position.x, camera.position.z),
    bearingDeg: directionToBearing(forward.x, forward.z),
    pitchDeg: (Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)) * 180) / Math.PI,
    fovDeg: camera.fov || DEFAULT_FOV_DEG,
  };
}

/** Puts the camera at `view`, orbiting around where its gaze meets the
 * ground (the 2D map's centre, for a view carried over from the map). */
function showViewAt(
  built: BuiltScene,
  camera: THREE.PerspectiveCamera | null,
  controls: OrbitControls | null,
  view: CameraPose
): void {
  if (!camera || !controls) return;
  const { anchor, terrain } = built;
  const [x, z] = toLocal(anchor, view.lng, view.lat);
  const [dx, dz] = bearingToDirection(view.bearingDeg);
  const pitch = (view.pitchDeg * Math.PI) / 180;
  const forward = new THREE.Vector3(dx * Math.cos(pitch), Math.sin(pitch), dz * Math.cos(pitch));
  camera.fov = view.fovDeg;
  camera.position.set(x, terrain.heightAt(x, z) + Math.max(view.eyeHeight, MIN_CAMERA_HEIGHT_M), z);
  camera.updateProjectionMatrix();
  const hit = terrain.flat ? null : intersectTerrain(terrain, camera.position, forward);
  const distance = hit ? hit.distance : forward.y < -1e-3 ? camera.position.y / -forward.y : LOOK_DISTANCE_M;
  controls.target.copy(camera.position).addScaledVector(forward, Math.max(distance, controls.minDistance));
  clampToGround(terrain, camera, controls);
  controls.update();
}

function frameSite(
  built: BuiltScene,
  camera: THREE.PerspectiveCamera | null,
  controls: OrbitControls | null
): void {
  if (!camera || !controls) return;
  const { minX, maxX, minZ, maxZ } = built.bounds;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const extent = Math.max(maxX - minX, maxZ - minZ);
  const { terrain } = built;

  const ground = terrain.heightAt(centerX, centerZ);
  controls.target.set(centerX, ground, centerZ);
  camera.position.set(centerX + extent * 0.6, ground + extent * 0.55, centerZ + extent * 0.8);
  // A placed viewpoint may have left its own field of view.
  camera.fov = OVERVIEW_FOV_DEG;
  camera.updateProjectionMatrix();
  clampToGround(terrain, camera, controls);
  controls.update();
}
