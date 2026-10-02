import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { CardSpec, DiscreteElement, InterventionDisplayMode, SceneResponse } from "../api/types";
import { buildScene, disposeGroup, type BuiltScene } from "./SceneBuilder";
import { applyNightLights, updateStreetlightShadows } from "./builders/streetlights";
import { updateWaterSun } from "./builders/water";
import { buildPlacards, disposePlacards, facePlacards, type Placards } from "./builders/placards";
import { Lighting } from "./Lighting";
import { MaterialLibrary } from "./materials";
import { terminateTreeWorkerPool } from "./workers/treeWorkerPool";
import type { SeasonState, SunPosition } from "./sun";
import { DEFAULT_FOV_DEG, LOOK_DISTANCE_M, MIN_CAMERA_HEIGHT_M, OVERVIEW_FOV_DEG, type CameraPose } from "./camera";
import { anchorFromPolygon, bearingToDirection, directionToBearing, toLocal, toLngLat, type GeoAnchor } from "./geo";
import { WalkController } from "./walk";
import { Crowd } from "./people/Crowd";
import { crowdSize, planCrowd } from "./people/plan";
import { buildWalkNetwork, type WalkNetwork } from "./people/network";
import { planWalkers } from "./people/walkers";
import { buildRoadNetwork, Traffic, type RoadNetwork } from "./people/traffic";
import type { CrowdActivity, LifeMode } from "./people/activity";
import { PerfRecorder, type PerfSummary } from "./perf";

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
}

interface ViewerProps {
  scene: SceneResponse | null;
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
   * prop rather than recomputed here. */
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
  // What the crowd was last planned against: the elements actually built
  // (with or without interventions) and the build's anchor/footprints.
  const crowdSceneRef = useRef<{
    elements: DiscreteElement[];
    built: BuiltScene;
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
    const placed = planCrowd(input.elements, input.built.anchor, input.built.footprints, activity);
    crowdRef.current.setPlan(placed);
    // Walkers are everyone who isn't standing or sitting somewhere.
    const walkers = Math.max(0, crowdSize(activity).total - placed.length);
    crowdRef.current.setWalkers(planWalkers(walkers, input.network), input.network, activity.dark);
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

    const camera = new THREE.PerspectiveCamera(OVERVIEW_FOV_DEG, 1, 0.1, 3000);
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

    const controls = new OrbitControls(camera, renderer.domElement);
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
      // Leave the orbit target where the walker was looking, so exiting the
      // walk doesn't teleport the view back to wherever it started.
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      // When looking down, put the target where the gaze actually meets the
      // ground rather than a fixed distance ahead — that would bury it under
      // the pavement, and the floor clamp would then jerk the view on the next
      // frame. This way the direction is preserved exactly and you end up
      // orbiting the spot you were just looking at.
      let distance = LOOK_DISTANCE_M;
      if (forward.y < -1e-3) {
        distance = Math.min(distance, (camera.position.y - MIN_CAMERA_HEIGHT_M) / -forward.y);
      }
      // Floor matches controls.minDistance. Kept low deliberately: a larger
      // one would overshoot the ground on a steep downward look, and the
      // target clamp below would then swing the view a couple of degrees.
      controls.target
        .copy(camera.position)
        .addScaledVector(forward, Math.max(distance, controls.minDistance));
      if (controls.target.y < 0) controls.target.y = 0;
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
    const handlePointerMove = (event: PointerEvent) => {
      if (event.buttons !== 0) return;
      renderer.domElement.style.cursor = placardAt(event) ? "pointer" : "";
    };
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);

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

    // Re-picking the nearest N shadow-casting streetlights (see
    // updateStreetlightShadows) touches every light on site and, for
    // whichever ones flip on, makes the renderer produce a new cube shadow
    // map that frame — worth throttling the same way view reporting is
    // above, on both time and movement, rather than doing it every frame.
    const SHADOW_CASTER_INTERVAL_MS = 500;
    const SHADOW_CASTER_MIN_MOVE_M = 3;
    const SHADOW_CASTER_MIN_TURN_RAD = (15 * Math.PI) / 180;
    const casterDirection = new THREE.Vector3();

    const updateShadowCasters = (now: number) => {
      const built = builtRef.current;
      if (!built || built.streetlights.lights.length === 0) return;
      const state = shadowCasterStateRef.current;
      if (now - state.time < SHADOW_CASTER_INTERVAL_MS) return;
      // Which lamps get real lights depends on what's in view too (see
      // builders/streetlights.ts), so turning counts as well as moving.
      camera.getWorldDirection(casterDirection);
      const moved = camera.position.distanceTo(state.position) >= SHADOW_CASTER_MIN_MOVE_M;
      const turned = casterDirection.angleTo(state.direction) >= SHADOW_CASTER_MIN_TURN_RAD;
      if (!moved && !turned) return;
      state.time = now;
      state.position.copy(camera.position);
      state.direction.copy(casterDirection);
      updateStreetlightShadows(built.streetlights, camera);
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

      notify(cameraView(camera, built.anchor), walk.isLocked ? "walk" : "orbit");
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
        if (controls.target.y < 0) controls.target.y = 0;
        if (camera.position.y < MIN_CAMERA_HEIGHT_M) camera.position.y = MIN_CAMERA_HEIGHT_M;
      }
      lighting.update(clock.elapsedTime);
      updateShadowCasters(performance.now());
      for (const water of builtRef.current?.waterSurfaces ?? []) {
        water.material.uniforms.time.value = clock.elapsedTime;
        water.material.uniforms.eye.value.copy(camera.position);
      }
      if (placardsRef.current) facePlacards(placardsRef.current, camera);
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
      if (placardsRef.current) disposePlacards(placardsRef.current);
      placardsRef.current = null;
      crowd.dispose();
      crowdRef.current = null;
      traffic.dispose();
      trafficRef.current = null;
      crowdSceneRef.current = null;
      controls.dispose();
      walk.dispose();
      if (builtRef.current) disposeGroup(builtRef.current.group);
      lighting.dispose();
      materialsRef.current?.dispose();
      terminateTreeWorkerPool();
      composer.dispose();
      composerRef.current = null;
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      builtRef.current = null;
      framedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const threeScene = threeSceneRef.current;
    const materials = materialsRef.current;
    const lighting = lightingRef.current;
    if (!scene || !threeScene || !materials || !lighting) return;

    let cancelled = false;
    buildScene(scene, materials, showInterventions, season).then((built) => {
      // The effect can re-fire (or the component unmount) while a build is in
      // flight; dropping a stale result avoids adding an orphaned group.
      if (cancelled) {
        disposeGroup(built.group);
        return;
      }
      if (builtRef.current) {
        threeScene.remove(builtRef.current.group);
        disposeGroup(builtRef.current.group);
      }
      threeScene.add(built.group);
      builtRef.current = built;
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
      crowdSceneRef.current = {
        elements: crowdElements,
        built,
        network: networkRef.current.network,
        roads: roadsRef.current.roads,
      };
      replanCrowd();
      // fitTo moves the shadow camera's centre, so the sun has to be re-placed
      // relative to it afterwards.
      lighting.fitTo(built.bounds);
      lighting.setSun(sunRef.current);
      applyNightLights(built.streetlights, materials, sunRef.current.altitudeDeg);
      // Facade materials are cached/shared by colour (see materials.ts's
      // facade()), not rebuilt per scene — but a rebuild can still be the
      // first time a given colour's material gets created, so this has to
      // run here too, not just from the sun-change effect below.
      materials.applyNightWindows(sunRef.current.altitudeDeg);
      // A rebuild's fresh Water instances (see builders/water.ts) start with
      // a placeholder sun direction until this runs — without it a pond
      // would briefly show the wrong specular highlight after every model
      // edit, not just the ones that happen to also change the sun.
      updateWaterSun(built.waterSurfaces, sunRef.current);
      // A rebuild creates a fresh array of PointLight objects (see
      // buildStreetlights), all starting castShadow=false — without this the
      // render loop's throttle (see updateShadowCasters) could wait up to
      // SHADOW_CASTER_MIN_MOVE_M of camera movement before picking any
      // casters for them, leaving newly-placed or newly-loaded streetlights
      // shadowless until the facilitator happens to walk a few metres.
      if (cameraRef.current) {
        updateStreetlightShadows(built.streetlights, cameraRef.current);
        shadowCasterStateRef.current.time = performance.now();
        shadowCasterStateRef.current.position.copy(cameraRef.current.position);
        cameraRef.current.getWorldDirection(shadowCasterStateRef.current.direction);
      }

      // Frame the site once, on the first successful build — and only when no
      // viewpoint was placed, since a pose is an explicit instruction about
      // where to stand. Re-framing on every edit would yank the view away from
      // wherever the facilitator had put it.
      if (pendingViewRef.current) {
        showViewAt(built.anchor, cameraRef.current, controlsRef.current, pendingViewRef.current);
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
      walkRef.current?.setCollision(built.footprints, built.bounds);
    });

    return () => {
      cancelled = true;
    };
  }, [scene, showInterventions, season]);

  useEffect(() => {
    replanCrowd();
  }, [crowdActivity.level, crowdActivity.traffic, crowdActivity.dark]);

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
      applyNightLights(builtRef.current.streetlights, materialsRef.current, sun.altitudeDeg);
      materialsRef.current.applyNightWindows(sun.altitudeDeg);
    }
    if (builtRef.current) {
      updateWaterSun(builtRef.current.waterSurfaces, sun);
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
  // not a whole scene rebuild.
  useEffect(() => {
    const threeScene = threeSceneRef.current;
    if (!threeScene) return;
    if (placardsRef.current) {
      threeScene.remove(placardsRef.current.group);
      disposePlacards(placardsRef.current);
      placardsRef.current = null;
    }
    if (!scene || mode !== "cards") return;
    const placards = buildPlacards(scene.interventions, cards, anchorFromPolygon(scene.site_boundary), scene.t);
    threeScene.add(placards.group);
    placardsRef.current = placards;
  }, [scene, cards, mode]);

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
      return cameraView(camera, built.anchor);
    },
    showView: (view: CameraPose) => {
      const built = builtRef.current;
      if (!built) {
        pendingViewRef.current = view;
        return;
      }
      walkRef.current?.controls.unlock();
      showViewAt(built.anchor, cameraRef.current, controlsRef.current, view);
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
      link.download = `${(scene?.site_id ?? "vista").replaceAll("_", "-")}-t${t}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.png`;
      link.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  return (
    <div className="viewer-stage">
      <div ref={containerRef} className="viewer-canvas" />
      {walking ? (
        <div className="viewer-walk-hint">
          WASD o frecce per muoverti · Shift per correre · Esc per uscire
        </div>
      ) : (
        <button
          type="button"
          className="viewer-walk-button"
          onClick={() => controlsRef.current && walkRef.current?.lock(controlsRef.current.target)}
        >
          Cammina nello spazio
        </button>
      )}
    </div>
  );
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

  const eye = Math.max(pose.eyeHeight, MIN_CAMERA_HEIGHT_M);
  camera.fov = pose.fovDeg;
  camera.position.set(x, eye, z);
  camera.updateProjectionMatrix();
  // Orbiting around a point ahead of the viewer, rather than around the whole
  // site, keeps "look around from where I'm standing" the natural gesture.
  controls.target.set(
    x + dx * LOOK_DISTANCE_M,
    Math.max(0, eye + Math.tan(pitch) * LOOK_DISTANCE_M),
    z + dz * LOOK_DISTANCE_M
  );
  controls.update();
}

/** The camera's current position and direction, as a pose. */
function cameraView(camera: THREE.PerspectiveCamera, anchor: GeoAnchor): CameraPose {
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const [lng, lat] = toLngLat(anchor, camera.position.x, camera.position.z);
  return {
    lng,
    lat,
    eyeHeight: camera.position.y,
    bearingDeg: directionToBearing(forward.x, forward.z),
    pitchDeg: (Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)) * 180) / Math.PI,
    fovDeg: camera.fov || DEFAULT_FOV_DEG,
  };
}

/** Puts the camera at `view`, orbiting around where its gaze meets the
 * ground (the 2D map's centre, for a view carried over from the map). */
function showViewAt(
  anchor: GeoAnchor,
  camera: THREE.PerspectiveCamera | null,
  controls: OrbitControls | null,
  view: CameraPose
): void {
  if (!camera || !controls) return;
  const [x, z] = toLocal(anchor, view.lng, view.lat);
  const [dx, dz] = bearingToDirection(view.bearingDeg);
  const pitch = (view.pitchDeg * Math.PI) / 180;
  const forward = new THREE.Vector3(dx * Math.cos(pitch), Math.sin(pitch), dz * Math.cos(pitch));
  camera.fov = view.fovDeg;
  camera.position.set(x, Math.max(view.eyeHeight, MIN_CAMERA_HEIGHT_M), z);
  camera.updateProjectionMatrix();
  const distance = forward.y < -1e-3 ? camera.position.y / -forward.y : LOOK_DISTANCE_M;
  controls.target.copy(camera.position).addScaledVector(forward, Math.max(distance, controls.minDistance));
  if (controls.target.y < 0) controls.target.y = 0;
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

  controls.target.set(centerX, 0, centerZ);
  camera.position.set(centerX + extent * 0.6, extent * 0.55, centerZ + extent * 0.8);
  // A placed viewpoint may have left its own field of view.
  camera.fov = OVERVIEW_FOV_DEG;
  camera.updateProjectionMatrix();
  controls.update();
}
