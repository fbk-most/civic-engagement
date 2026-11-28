import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapLayerMouseEvent, MapLibreMap } from "maplibre-gl";
import type { TerraDraw } from "terra-draw";
import "maplibre-gl/dist/maplibre-gl.css";
import "./App.css";
import { createMap } from "./map/mapSetup";
import { DISABLED_INTERVENTION_LAYERS, renderScene, setCameraView, setHighlight } from "./map/layers";
import { mapToView, readMapFraming, sameFraming, sameView, viewToMap, type MapFraming } from "./map/viewSync";
import { frustumWedge, type CameraPose } from "./three/camera";
import { anchorFromPolygon, toLocal } from "./three/geo";
import { FLAT_TERRAIN, terrainFromGrid, type Terrain } from "./three/terrain";
import { readDebugParams } from "./debugParams";
import { createDraw } from "./map/terraDrawSetup";
import {
  createIntervention,
  HttpError,
  deleteIntervention,
  fetchCards,
  fetchDeferredIndicators,
  fetchIndicatorDescriptors,
  fetchScene,
  fetchScenarios,
  fetchSessionRevision,
  fetchSiteAssets,
  fetchTerrainGrid,
  fetchThermalField,
  fetchViews,
  setInterventionEnabled,
  setPhaseRefusedHandler,
  updateIntervention,
} from "./api/client";
import type {
  CardSpec,
  DeferredIndicators,
  IndicatorDescriptors,
  InterventionDisplayMode,
  Panel,
  PlacementType,
  ScenarioInfo,
  SceneResponse,
  TerrainGrid,
  ViewSpec,
} from "./api/types";
import { CardPalette } from "./ui/CardPalette";
import { ParamForm } from "./ui/ParamForm";
import { TimeSlider } from "./ui/TimeSlider";
import { IndicatorsView } from "./ui/IndicatorsView";
import { activePack } from "./pack";
import { KpiPanel } from "./ui/KpiPanel";
import { InterventionsToggle } from "./ui/InterventionsToggle";
import { InterventionList } from "./ui/InterventionList";
import { TreeIdentityCard } from "./ui/TreeIdentityCard";
import { MapLegend } from "./ui/MapLegend";
import { InterventionInfoCard } from "./ui/InterventionInfoCard";
import { downloadCanvas, imageFileName } from "./imageExport";
import { CardOffNotice } from "./ui/CardOffNotice";
import { View3D, type View3DViewHandle } from "./ui/View3D";
import { ThermalPanel } from "./ui/ThermalPanel";
import { SunControl } from "./ui/SunControl";
import { setThermalLayer } from "./map/thermalLayer";
import { decodeField, layerAt, valueAt, type ThermalField, type ThermalReading } from "./thermal/field";
import type { CrowdExposure } from "./three/people/comfort";
import { dailyComfort, type HourComfort } from "./three/people/daily";
import { buildWalkNetwork } from "./three/people/network";
import { CURRENT_YEAR, DEFAULT_SUN_SETTING, SEASON_PRESETS, sunPosition, type SunSetting } from "./three/sun";
import { ViewTabs, type AppView } from "./ui/ViewTabs";
import { LangSwitch } from "./ui/LangSwitch";
import { TempSwitch } from "./ui/TempSwitch";
import { ScenarioMenu } from "./ui/ScenarioMenu";
import { ComparisonPicker } from "./ui/ComparisonPicker";
import { ComparisonView } from "./ui/ComparisonView";
import { ComparisonView3D } from "./ui/ComparisonView3D";
import { initialCompared, keptCompared, sourceKey, sourceLabel, type Compared, type ComparedSource, type Side } from "./comparison";
import { TeamBadge } from "./ui/TeamBadge";
import { can, useAccess } from "./access";
import { panelShown, resolveView, tabAfter, viewInterventionMode, viewTabs } from "./views";
import { tr, useLang } from "./i18n/lang";
import { withinBoundary } from "./map/boundary";
import { useTempUnit } from "./i18n/units";
import { useNotes } from "./notes/useNotes";
import { NotesRail } from "./notes/NotesRail";
import { notesClaimClick } from "./notes/notesLayer";
import { NotesPanel } from "./notes/NotesPanel";
import * as timeline from "./perf/timeline";

type Status = "loading" | "ready" | "error";

// Read once at module load, not per render — the query string doesn't change
// during the app's lifetime, and this seeds several independent pieces of
// initial state below (scenario year, camera pose, which view opens first).
const initialDebugParams = readDebugParams();

// Felt-temperature fields fetched so far (about 1.3 MB each once decoded),
// by everything that determines one: going back to a year or date already
// seen doesn't ask the backend again.
const FIELD_CACHE_SIZE = 16;
const fieldCache = new Map<string, ThermalField>();
const FIELD_REQUEST_DELAY_MS = 250;

function fieldKey(t: number, month: number, day: number, asIs: boolean, interventionsKey: string): string {
  return JSON.stringify([t, month, day, asIs, asIs ? "" : interventionsKey]);
}

// The KPI panel's deferred indicators fetched so far, by year and cards.
const kpiDeferredCache = new Map<string, DeferredIndicators>();
const KPI_DEFERRED_CACHE_SIZE = 40;
/** How often a visible window asks whether another one changed the session. */
const REVISION_POLL_MS = 3000;
// How long a notice over the map stays.
const NOTICE_MS = 4000;

function outsideMessage(): string {
  return tr("Le carte vanno posizionate dentro il confine del sito.", "Cards go within the site’s boundary.");
}

// Daily curves computed so far, by the key of the field they read.
const curveCache = new Map<string, HourComfort[]>();

/** The thermal panel's daily curve: without the interventions, and with
 * them (null when there are none); today without them, for comparison,
 * when the year shown is a later one (null otherwise); `key`, which fields
 * it was computed from. */
interface DailyCurve {
  today: HourComfort[] | null;
  current: HourComfort[];
  /** The year shown, as years from now. */
  years: number;
  planned: HourComfort[] | null;
  key: string;
}

function fetchFieldIntoCache(key: string, t: number, month: number, day: number, asIs: boolean): Promise<void> {
  return fetchThermalField(t, month, day, asIs).then((response) => {
    fieldCache.set(key, decodeField(response));
    if (fieldCache.size > FIELD_CACHE_SIZE) fieldCache.delete(fieldCache.keys().next().value!);
  });
}

/** The cards as placed (not the year shown): to tell whether they're still
 * those of a scenario loaded. */
function cardsKey(interventions: SceneResponse["interventions"]): string {
  return JSON.stringify(interventions.map((i) => [i.id, i.card_type, i.geometry, i.params, i.planted_year, i.enabled]));
}

function App() {
  // Re-render the whole tree on a change of language or of temperature
  // unit (see i18n/lang.ts, i18n/units.ts).
  const lang = useLang();
  const tempUnit = useTempUnit();
  // With teams, a viewer only looks: no cards to place, change or remove,
  // no scenarios to load or save; an editor, only what the team's phase
  // allows (the backend refuses the rest anyway).
  const access = useAccess();
  const canEditInterventions = can(access, "interventions.edit");
  const { refresh: refreshAccess } = access;
  // The view shown (see views.ts): the one in the URL's fragment or query,
  // if the team's phase has it, else the phase's default; none (everything
  // shown) without views. The fragment's changes are applied as they come.
  // Null until the pack's views are known.
  const [views, setViews] = useState<ViewSpec[] | null>(null);
  useEffect(() => {
    fetchViews()
      .then(setViews)
      .catch((err) => {
        console.error(err);
        setViews([]);
      });
  }, []);
  const [urlHash, setUrlHash] = useState(window.location.hash);
  useEffect(() => {
    const follow = () => setUrlHash(window.location.hash);
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const { me } = access;
  const screenView = useMemo(
    () => resolveView(window.location.search, urlHash, me.phase === null ? null : me.views, views ?? []),
    [urlHash, me, views]
  );
  // Each panel: the view has it and, for the controls of a change, the
  // role and the phase allow it.
  const shown = (panel: Panel) => panelShown(screenView, panel, me.operations);
  // Placing cards, and changing or removing those placed.
  const canPlace = shown("cards");
  // The phase this window's controls follow, for the revision check below.
  const phaseRef = useRef(access.me.phase);
  phaseRef.current = access.me.phase;
  const containerRef = useRef<HTMLDivElement>(null);
  // Guards against React 18 StrictMode's dev-only double effect invocation:
  // creating a second MapLibre GL (WebGL) instance while the first is mid-init
  // leaves the map permanently stuck ("style never finishes loading"), so we
  // deliberately only ever construct the map once per real mount.
  const initializedRef = useRef(false);
  const mapRef = useRef<MapLibreMap | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const modeForPlacementRef = useRef<Partial<Record<PlacementType, string>>>({});
  const sceneRef = useRef<SceneResponse | null>(null);
  // Dragging the time slider fires onChange on every year it crosses, each
  // kicking off its own fetchScene request; those requests can resolve out
  // of order (a slower request for a year passed through mid-drag can land
  // after the fetch for where the drag actually stopped). Only the response
  // matching the most recently *issued* request is allowed to apply.
  const timeRequestSeqRef = useRef(0);
  const interventionModeRef = useRef<InterventionDisplayMode>(initialDebugParams.interventionMode ?? "simulated");
  const cardsRef = useRef<CardSpec[]>([]);
  const selectedCardRef = useRef<CardSpec | null>(null);

  const [status, setStatus] = useState<Status>("loading");
  const [cards, setCards] = useState<CardSpec[]>([]);
  const [indicatorDescriptors, setIndicatorDescriptors] = useState<IndicatorDescriptors | null>(null);
  cardsRef.current = cards;
  const [selectedCard, setSelectedCard] = useState<CardSpec | null>(null);
  const [pendingGeometry, setPendingGeometry] = useState<GeoJSON.Geometry | null>(null);
  // A short message over the map (a card drawn outside the site), gone by itself.
  const [notice, setNotice] = useState<string | null>(null);
  // The backend can't save changes any more (see the revision check below).
  const [restartNeeded, setRestartNeeded] = useState(false);
  const noticeTimerRef = useRef<number | undefined>(undefined);
  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  // A change refused by the team's phase: it changed since this window
  // last asked. Says so, and asks again (the controls follow).
  useEffect(() => {
    setPhaseRefusedHandler(() => {
      showNotice(tr("La fase attuale non lo consente.", "Not allowed in the current phase."));
      refreshAccess();
    });
  }, [showNotice, refreshAccess]);
  const [t, setT] = useState(initialDebugParams.t ?? 0);
  const [scene, setScene] = useState<SceneResponse | null>(null);
  // The scenario last loaded, and its cards as loaded: an image is named
  // after it while the cards are still those (see imageName).
  const [loadedScenario, setLoadedScenario] = useState<{ name: string; cards: string } | null>(null);
  // Two scenarios compared (the `compare` panel): each side's source, null
  // until the scenarios to choose from are first read.
  const [compared, setCompared] = useState<Compared | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  // Null until known (flat if the site has no terrain grid). The ref is for
  // the tab switches' camera carry-over, which read it outside React.
  const [terrain, setTerrain] = useState<Terrain | null>(null);
  const terrainRef = useRef<Terrain>(FLAT_TERRAIN);
  // Scene requests applied but not yet rendered (see applyScene).
  const scenesToEndRef = useRef(0);
  useEffect(() => {
    for (; scenesToEndRef.current > 0; scenesToEndRef.current--) timeline.end("scene");
  }, [scene]);
  // The switch's choice; a view without the switch says its own.
  const [chosenInterventionMode, setInterventionMode] = useState<InterventionDisplayMode>(
    initialDebugParams.interventionMode ?? "simulated"
  );
  const interventionMode = viewInterventionMode(screenView, chosenInterventionMode);
  const [selectedInterventionId, setSelectedInterventionId] = useState<string | null>(null);
  const [selectedTreeElementId, setSelectedTreeElementId] = useState<string | null>(null);
  const [replantTargetId, setReplantTargetId] = useState<string | null>(null);
  const [tab, setTab] = useState<AppView>(initialDebugParams.viewerOpen ? "3d" : "2d");
  // The 3D view is only created the first time its tab is opened (no point
  // building trees nobody looks at), then kept alive across tab switches.
  const [view3dMounted, setView3dMounted] = useState(tab === "3d");
  // The team's notes (notes/): opening one, or adding one, closes the rest.
  const closeForNotes = useCallback(() => {
    setSelectedCard(null);
    setPendingGeometry(null);
    setReplantTargetId(null);
    setSelectedInterventionId(null);
    setSelectedTreeElementId(null);
  }, []);
  const notes = useNotes({
    mapRef,
    sceneRef,
    ready: status === "ready",
    shown: views !== null && shown("notes"),
    canEdit: can(access, "notes.edit"),
    on2d: tab === "2d",
    blocked: selectedCard !== null,
    showNotice,
    onActivate: closeForNotes,
  });
  const notesRef = useRef(notes);
  notesRef.current = notes;
  useEffect(() => {
    if (selectedCard || selectedInterventionId || selectedTreeElementId) notesRef.current.select(null);
  }, [selectedCard, selectedInterventionId, selectedTreeElementId]);
  const [cameraPose, setCameraPose] = useState<CameraPose | null>(initialDebugParams.pose);
  // Keeping the map and the 3D view on the same framing across tab switches
  // (see map/viewSync.ts): what each showed right after the last alignment,
  // so a view that hasn't been moved since isn't disturbed.
  const view3dRef = useRef<View3DViewHandle>(null);
  const previousTabRef = useRef<AppView>(tab);
  const alignedRef = useRef<{ map: MapFraming; view: CameraPose } | null>(null);
  const [initial3dView, setInitial3dView] = useState<CameraPose | null>(null);
  // Day and hour, shared by the 3D view's sun and the felt-temperature layer.
  const [sunSetting, setSunSetting] = useState<SunSetting>(initialDebugParams.sun ?? DEFAULT_SUN_SETTING);
  // The felt-temperature field drawn on the ground, and the panel with its
  // figures: separate choices (the figures, and the daily curve, make sense
  // without the colours over the scene).
  // The felt-temperature field is the domain's (see FrontendPack.features):
  // without it, nothing below ever asks for one.
  const { features } = activePack();
  // Both off in a view without the thermal panel.
  const thermalAllowed = features.thermal && shown("thermal");
  const [thermalOnChosen, setThermalOn] = useState(initialDebugParams.thermal && features.thermal);
  const [thermalPanelOpenChosen, setThermalPanelOpen] = useState(initialDebugParams.thermal && features.thermal);
  const thermalOn = thermalOnChosen && thermalAllowed;
  const thermalPanelOpen = thermalPanelOpenChosen && thermalAllowed;
  const [thermalFailed, setThermalFailed] = useState(false);
  const [thermalReading, setThermalReading] = useState<ThermalReading>(null);
  // How the 3D view's crowd fares in the felt temperature (see Viewer).
  const [crowdExposure, setCrowdExposure] = useState<CrowdExposure | null>(null);
  // Read by the map's pointer handler, registered once.
  const thermalLayerRef = useRef<{ field: ThermalField; layer: Float32Array } | null>(null);
  // The 3D field of view drawn on the map after leaving an eye-level view;
  // renderScene clears it, so it's redrawn after every render.
  const mapWedgeRef = useRef<Parameters<typeof setCameraView>[1]>(null);
  /** "Scarica immagine"'s file name: the scenario's while the cards are as
   * loaded (changed here or from another window), "corrente" otherwise. */
  function imageName(view: "2d" | "3d"): string {
    const current = sceneRef.current;
    const scenario = loadedScenario && current && cardsKey(current.interventions) === loadedScenario.cards ? loadedScenario.name : null;
    return imageFileName({ site: current?.site_id ?? "site", team: access.me.team.id, scenario, year: CURRENT_YEAR + t, view });
  }

  /** The comparison's image: both scenarios, named after both. */
  function pairImageName(pair: Record<Side, ComparedSource>, view: "2d" | "3d"): string {
    const name = (side: Side) => (pair[side].scenario === null ? "corrente" : pair[side].label);
    const scenario = `${name("a")} vs ${name("b")}`;
    return imageFileName({ site: sceneRef.current?.site_id ?? "site", team: access.me.team.id, scenario, year: CURRENT_YEAR + t, view });
  }

  function downloadMapImage() {
    const map = mapRef.current;
    if (!map) return;
    const name = imageName("2d");
    // MapLibre clears its buffer after each frame: read it in the next one.
    map.once("render", () => downloadCanvas(map.getCanvas(), name));
    map.triggerRepaint();
  }

  function renderMap(map: MapLibreMap, newScene: SceneResponse, mode: InterventionDisplayMode) {
    renderScene(map, newScene, mode, cardsRef.current);
    setCameraView(map, mapWedgeRef.current);
  }
  function applyScene(newScene: SceneResponse) {
    sceneRef.current = newScene;
    setScene(newScene);
    // The request's wait ends once React has applied the scene (below), so
    // that what it sets off (a 3D build) is already pending by then.
    scenesToEndRef.current++;
    if (mapRef.current) renderMap(mapRef.current, newScene, interventionModeRef.current);
  }

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;
    // Startup is the first change, timed from the page load until the
    // first view is consistent; the scene is asked for once the map loads.
    timeline.markInput("avvio", 0);
    timeline.begin("scene");

    const map = createMap(containerRef.current);
    mapRef.current = map;
    map.on("error", (e) => console.error("MapLibre error:", e.error));

    map.on("load", () => {
      // The terrain grid, if the site has one, comes alongside the scene;
      // the 3D view waits for both.
      const terrainGrid: Promise<TerrainGrid | null> = initialDebugParams.terrain
        ? fetchSiteAssets().then(({ assets }) => {
            const asset = assets.find((a) => a.key === "terrain_grid");
            return asset ? fetchTerrainGrid(asset) : null;
          })
        : Promise.resolve(null);
      // Matches `t`'s own initial state (see initialDebugParams above) rather
      // than a bare 0, or a `?t=5` debug URL would show the slider at 5 while
      // actually rendering the t=0 scenario until the slider was touched.
      fetchScene(initialDebugParams.t ?? 0)
        .then((scene) => {
          applyScene(scene);
          setStatus("ready");
          terrainGrid
            .then((grid) =>
              grid
                ? terrainFromGrid(grid, anchorFromPolygon(scene.site_boundary), initialDebugParams.terrainScale ?? 1)
                : FLAT_TERRAIN
            )
            .catch((err) => {
              console.error(err);
              return FLAT_TERRAIN;
            })
            .then((loaded) => {
              terrainRef.current = loaded;
              setTerrain(loaded);
            });
        })
        .catch((err) => {
          console.error(err);
          timeline.end("scene");
          setStatus("error");
        });

      const { draw, modeForPlacement } = createDraw(map);
      drawRef.current = draw;
      modeForPlacementRef.current = modeForPlacement;
      draw.on("finish", (id) => {
        const feature = draw.getSnapshotFeature(id);
        if (!feature) return;
        // Cards are for the site: past a surveyed boundary is context (a
        // provisional one, not drawn, doesn't bind; as in the backend).
        const current = sceneRef.current;
        if (current?.boundary_status === "surveyed" && !withinBoundary(feature.geometry, current.site_boundary)) {
          draw.removeFeatures([id]);
          showNotice(outsideMessage());
          return;
        }
        setPendingGeometry(feature.geometry);
        draw.stop();
      });

      // Makes every tree (baseline or placed) clickable: baseline trees open
      // a read-only identity card, placed trees jump to their existing
      // intervention edit flow (selected via the InterventionList already).
      const mapLayers = activePack().map.layers;
      const TREE_LAYERS = mapLayers.filter((layer) => layer.interaction === "tree").map((layer) => layer.id);
      for (const layerId of TREE_LAYERS) {
        map.on("mouseenter", layerId, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = "";
        });
      }
      // In "cards" mode a placed intervention is only a marker, not its full
      // geometry — clicking it still opens the same edit/delete form as
      // selecting it from the intervention list, so picking a card back up
      // works the same way regardless of display mode.
      map.on("mouseenter", "intervention-markers-fill", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "intervention-markers-fill", () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("click", "intervention-markers-fill", (e) => {
        if (selectedCardRef.current || notesClaimClick(map, e)) return;
        const feature = e.features?.[0];
        if (!feature) return;
        const props = feature.properties as { interventionId: string };
        setPendingGeometry(null);
        setSelectedTreeElementId(null);
        setSelectedInterventionId(props.interventionId);
      });
      // Every other selectable layer in "simulated" mode (trees have their
      // own handler above, since baseline trees open an identity card
      // instead of selecting an intervention). Baseline features on these
      // same layers (existing OSM benches/streetlights) are click-through —
      // there's nothing to select, only placed interventions are editable.
      const SELECTABLE_LAYERS = [
        ...mapLayers.filter((layer) => layer.interaction === "select").map((layer) => layer.id),
        "covers-fill",
        ...DISABLED_INTERVENTION_LAYERS,
      ];
      for (const layerId of SELECTABLE_LAYERS) {
        map.on("mouseenter", layerId, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = "";
        });
        map.on("click", layerId, (e) => {
          if (selectedCardRef.current || notesClaimClick(map, e)) return;
          const feature = e.features?.[0];
          if (!feature) return;
          const props = feature.properties as { source?: string; interventionId?: string | null };
          if (props.source !== "intervention" || !props.interventionId) return;
          setPendingGeometry(null);
          setSelectedTreeElementId(null);
          setSelectedInterventionId(props.interventionId);
        });
      }
      const openTree = (e: MapLayerMouseEvent) => {
        // Ignore tree clicks while a card is armed for drawing/placement —
        // otherwise a click that happens to land on a tree hijacks it into
        // opening that tree's identity card instead, silently derailing
        // whatever the facilitator was doing.
        if (selectedCardRef.current || notesClaimClick(map, e)) return;
        const feature = e.features?.[0];
        if (!feature) return;
        const props = feature.properties as { source: string; elementId: string; interventionId: string | null };
        setPendingGeometry(null);
        if (props.source === "intervention" && props.interventionId) {
          setSelectedTreeElementId(null);
          setSelectedInterventionId(props.interventionId);
        } else {
          setSelectedInterventionId(null);
          setSelectedTreeElementId(props.elementId);
        }
      };
      for (const layerId of TREE_LAYERS) map.on("click", layerId, openTree);

      // The felt temperature under the pointer, while the layer is shown.
      map.on("mousemove", (e) => {
        const shown = thermalLayerRef.current;
        const current = sceneRef.current;
        if (!shown || !current) return;
        const [east, south] = toLocal(anchorFromPolygon(current.site_boundary), e.lngLat.lng, e.lngLat.lat);
        const celsius = valueAt(shown.field, shown.layer, east, -south);
        setThermalReading(celsius === null ? null : { celsius, where: "pointer" });
      });
      map.on("mouseout", () => setThermalReading(null));

      fetchCards().then(setCards).catch(console.error);
      fetchIndicatorDescriptors().then(setIndicatorDescriptors).catch(console.error);
    });
  }, [showNotice]);

  // The phase, or the view, no longer allows changing cards: a card armed,
  // or a form open, is dropped (as on a change of tab).
  useEffect(() => {
    if (canPlace) return;
    setSelectedCard(null);
    setPendingGeometry(null);
    setReplantTargetId(null);
  }, [canPlace]);

  useEffect(() => {
    selectedCardRef.current = selectedCard;
    const draw = drawRef.current;
    if (!draw) return;
    if (selectedCard) {
      const mode = modeForPlacementRef.current[selectedCard.placement_type];
      if (mode) {
        draw.start();
        draw.setMode(mode);
      }
    } else {
      draw.stop();
    }
  }, [selectedCard]);

  // Also when the cards arrive, maybe after the scene: the markers take
  // their colour from the card's category.
  useEffect(() => {
    interventionModeRef.current = interventionMode;
    if (mapRef.current && sceneRef.current) {
      renderMap(mapRef.current, sceneRef.current, interventionMode);
    }
  }, [interventionMode, cards]);

  // Tab switches carry the camera across: leaving 3D, the map takes the 3D
  // framing (or, from eye level, looks at the same place from above); coming
  // back, the 3D view takes the map's framing — each only if the other side
  // was actually moved since they were last aligned.
  useEffect(() => {
    const previous = previousTabRef.current;
    previousTabRef.current = tab;
    const map = mapRef.current;
    const currentScene = sceneRef.current;
    if (previous === tab || !map || !currentScene) return;
    const anchor = anchorFromPolygon(currentScene.site_boundary);
    const aligned = alignedRef.current;

    if (tab === "2d") {
      const shown = view3dRef.current?.readView();
      if (!shown || (aligned && sameView(shown, aligned.view, anchor))) return;
      const { framing, eyeLevel } = viewToMap(map, anchor, shown, terrainRef.current);
      map.jumpTo(framing);
      mapWedgeRef.current = eyeLevel ? { wedge: frustumWedge(anchor, shown), position: [shown.lng, shown.lat] } : null;
      setCameraView(map, mapWedgeRef.current);
      alignedRef.current = { map: readMapFraming(map), view: shown };
    } else if (tab === "3d") {
      const framing = readMapFraming(map);
      if (aligned && sameFraming(framing, aligned.map)) return;
      const next = mapToView(map, anchor, terrainRef.current);
      // The first time, the 3D view isn't there yet: it opens on this instead.
      if (view3dRef.current) view3dRef.current.showView(next);
      else setInitial3dView(next);
      alignedRef.current = { map: framing, view: next };
    }
  }, [tab]);

  // Not when comparing: the comparison has its own two (ComparisonView3D).
  const comparingView = views !== null && panelShown(screenView, "compare", me.operations);
  useEffect(() => {
    if (tab === "3d" && !comparingView) setView3dMounted(true);
  }, [tab, comparingView]);

  // A change of view (from the URL, or the phase's): the tab it opens on,
  // if that differs from the last view's or the tab shown isn't one it
  // offers; today's year if it hasn't the year slider. The first, once the
  // views are known, keeps a debug URL's 3D tab (?viewer=1) and year.
  const appliedViewRef = useRef<ViewSpec | null | undefined>(undefined);
  const applyViewRef = useRef((_previous: ViewSpec | null | undefined) => {});
  applyViewRef.current = (previous) => {
    const first = previous === undefined;
    const keep3d = first && tab === "3d" && viewTabs(screenView).includes("3d");
    const next = keep3d ? tab : tabAfter(previous ?? null, screenView, tab);
    if (next !== tab) handleViewTabChange(next);
    if (!first && screenView && !screenView.panels.includes("time") && t !== 0) handleTimeChange(0);
  };
  useEffect(() => {
    const previous = appliedViewRef.current;
    if (views === null || previous === screenView) return;
    appliedViewRef.current = screenView;
    applyViewRef.current(previous);
  }, [views, screenView]);

  useEffect(() => {
    // Guard on `scene` (not just the map ref): the map object exists synchronously
    // after construction, but its style/sources aren't ready until the "load"
    // event — which is also when the first scene fetch resolves — so using
    // `scene` as the readiness signal avoids calling addSource too early.
    if (!mapRef.current || !scene) return;
    const iv = scene.interventions.find((i) => i.id === selectedInterventionId) ?? null;
    setHighlight(mapRef.current, iv ? iv.geometry : null);
  }, [selectedInterventionId, scene]);

  // The felt-temperature field for the year and day shown, with the
  // interventions or without: for the layer when it's on (without only in
  // "Situazione attuale"), and for the 3D crowd, which reacts to it (and is measured against it) shown or
  // not — to the field of the scene the 3D view builds, so without in
  // "Carte proposte" too. Read straight from the cache while rendering, so a
  // field already fetched changes together with the date (and the 3D view's
  // season), not a render later. While the next one loads, the last one
  // stands in: dimmed on the map and in the 3D view, and for the crowd —
  // dropping it would replan everyone as if the weather were comfortable,
  // and again a second later when the field arrives.
  // What's evaluated: the cards turned on (the others are only listed and
  // drawn), so a card turned off and on again finds its fields cached.
  const enabledInterventions = useMemo(() => scene?.interventions.filter((i) => i.enabled) ?? [], [scene?.interventions]);

  // Comparing: the scenarios read when the view or the indicators tab opens
  // and when the picker is used (one saved meanwhile, in another window);
  // a side whose scenario is gone goes back to the current scene.
  const comparing = comparingView;
  const refreshScenarios = useCallback(() => {
    fetchScenarios()
      .then((list) => {
        setScenarios(list);
        setCompared((previous) => (previous === null ? initialCompared(list) : keptCompared(previous, list)));
      })
      .catch(console.error);
  }, []);
  useEffect(() => {
    if (comparing) refreshScenarios();
  }, [comparing, tab, refreshScenarios]);
  // Built at every render (the labels follow the language): the series are
  // fetched again only when a side's key changes.
  const comparedSource = (side: Side, chosen: Compared): ComparedSource => ({
    scenario: chosen[side],
    label: sourceLabel(chosen[side], scenarios, tr("Scena corrente", "Current scene")),
    key: sourceKey(chosen[side], scenarios, cardsKey(enabledInterventions)),
  });
  const comparison =
    comparing && compared !== null ? { a: comparedSource("a", compared), b: comparedSource("b", compared) } : undefined;
  const thermalAsIs = interventionMode === "hidden";
  const crowdAsIs = interventionMode !== "simulated";
  const comfortWanted = view3dMounted && features.thermal;
  // Which variants are needed, as "as is" flags: none, one, or both.
  // The panel's daily curve compares the situation with the interventions
  // and without, so it needs both — and, in a later year, today's without
  // (see `todayKey`). In "Situazione attuale", without them only.
  const curveWithProposals = enabledInterventions.length > 0 && interventionMode !== "hidden";
  const curveVariants = thermalPanelOpen ? (curveWithProposals ? [true, false] : [true]) : [];
  const wantedVariants = [
    ...new Set([
      ...(thermalOn || thermalPanelOpen ? [thermalAsIs] : []),
      ...(comfortWanted ? [crowdAsIs] : []),
      ...curveVariants,
    ]),
  ];
  const variantsKey = JSON.stringify(wantedVariants);
  const interventionsKey = useMemo(() => JSON.stringify(enabledInterventions), [enabledInterventions]);
  const keyFor = (asIs: boolean) => fieldKey(t, sunSetting.month, sunSetting.day, asIs, interventionsKey);

  // The KPI panel's deferred indicators (the thermal ones), fetched apart
  // from the scene (two fields the rest of the scene needn't wait for) for
  // the scene shown; kept per year and set of cards, so going back to a year
  // is instant.
  const sceneT = scene?.t ?? null;
  const kpiDeferredKey = sceneT === null ? null : JSON.stringify([sceneT, interventionsKey]);
  const [, setKpiDeferredFetched] = useState(0);
  const kpiDeferred = kpiDeferredKey === null ? null : kpiDeferredCache.get(kpiDeferredKey) ?? null;
  useEffect(() => {
    if (kpiDeferredKey === null || sceneT === null || kpiDeferredCache.has(kpiDeferredKey)) return;
    let cancelled = false;
    timeline.begin("kpi");
    fetchDeferredIndicators(sceneT)
      .then((result) => {
        kpiDeferredCache.set(kpiDeferredKey, result);
        if (kpiDeferredCache.size > KPI_DEFERRED_CACHE_SIZE) kpiDeferredCache.delete(kpiDeferredCache.keys().next().value!);
        if (!cancelled) setKpiDeferredFetched((n) => n + 1);
      })
      .catch((err) => console.error(err))
      .finally(() => timeline.end("kpi"));
    return () => {
      cancelled = true;
    };
  }, [kpiDeferredKey, sceneT]);
  // Bumped when a fetch lands, to render again with the cache's new entry.
  const [, setFieldsFetched] = useState(0);
  const thermalField = thermalOn || thermalPanelOpen ? fieldCache.get(keyFor(thermalAsIs)) ?? null : null;
  const comfortField = comfortWanted ? fieldCache.get(keyFor(crowdAsIs)) ?? null : null;
  const lastFieldRef = useRef<ThermalField | null>(null);
  if (thermalField) lastFieldRef.current = thermalField;
  const lastComfortFieldRef = useRef<ThermalField | null>(null);
  if (comfortField) lastComfortFieldRef.current = comfortField;
  const thermalHeld = thermalOn ? thermalField ?? lastFieldRef.current : null;
  const panelField = thermalPanelOpen || thermalOn ? lastFieldRef.current : null;
  const comfortHeld = comfortWanted ? comfortField ?? lastComfortFieldRef.current : null;
  const thermalLoading = (thermalOn || thermalPanelOpen) && !thermalField;

  // The daily curve, computed once all its fields are there; the last one
  // stays up (dimmed) while the next loads.
  const todayKey =
    thermalPanelOpen && t > 0 ? fieldKey(0, sunSetting.month, sunSetting.day, true, interventionsKey) : null;
  const curveKeys = [...curveVariants.map(keyFor), ...(todayKey ? [todayKey] : [])];
  const curveFields = curveKeys.map((key) => fieldCache.get(key) ?? null);
  const curveReady = curveFields.length > 0 && curveFields.every((field) => field !== null);
  const curveKey = JSON.stringify(curveKeys);
  const [dailyCurve, setDailyCurve] = useState<DailyCurve | null>(null);
  useEffect(() => {
    if (!curveReady || !scene) return;
    // After the render that brought the fields: the computation takes a
    // moment, and the view's own update comes first.
    const timer = setTimeout(() => {
      const keys = JSON.parse(curveKey) as string[];
      const anchor = anchorFromPolygon(scene.site_boundary);
      const site = (scene.site_boundary.coordinates[0] ?? []).flatMap(([lng, lat]) => toLocal(anchor, lng, lat));
      const curves = keys.map((key) => {
        let curve = curveCache.get(key);
        if (!curve) {
          const [kt, , , asIs] = JSON.parse(key) as [number, number, number, boolean];
          // Today's curve reads the elements of the year shown: without the
          // interventions, they differ from today's only by their trees,
          // which count through the field — places to stop and paths are
          // the same.
          const elements = asIs ? scene.elements.filter((e) => e.source === "baseline") : scene.elements;
          curve = dailyComfort({
            elements,
            network: buildWalkNetwork(elements, anchor, scene.site_boundary),
            anchor,
            site,
            field: fieldCache.get(key)!,
            month: sunSetting.month,
            day: sunSetting.day,
            year: CURRENT_YEAR + kt,
          });
          curveCache.set(key, curve);
          if (curveCache.size > FIELD_CACHE_SIZE) curveCache.delete(curveCache.keys().next().value!);
        }
        return curve;
      });
      const today = t > 0 ? curves.pop()! : null;
      setDailyCurve({ current: curves[0], planned: curves[1] ?? null, today, years: t, key: curveKey });
    }, 0);
    return () => clearTimeout(timer);
  }, [curveReady, curveKey, scene, sunSetting.month, sunSetting.day, t]);
  const curveShown = thermalPanelOpen && dailyCurve ? { ...dailyCurve, stale: dailyCurve.key !== curveKey } : null;
  const curvePending = curveReady && dailyCurve?.key !== curveKey;
  useEffect(() => {
    if (!curvePending) return;
    timeline.begin("curve");
    return () => timeline.end("curve");
  }, [curvePending]);

  // Changes the view has to catch up with, marked as they're asked for (the
  // year and cards: where they're handled), for the performance readout.
  function changeSunSetting(next: SunSetting) {
    if (next.month !== sunSetting.month || next.day !== sunSetting.day) timeline.markInput("date");
    else if (next.hour !== sunSetting.hour) timeline.markInput("hour");
    setSunSetting(next);
  }
  function changeInterventionMode(next: InterventionDisplayMode) {
    if (next !== interventionMode) timeline.markInput("interventions mode");
    setInterventionMode(next);
  }
  // Without the interventions (the switch, or the view), the deck and the
  // list go away (see the left rail): so does a card being placed, or one
  // being looked at.
  useEffect(() => {
    if (interventionMode !== "hidden") return;
    setSelectedCard(null);
    setPendingGeometry(null);
    setSelectedInterventionId(null);
  }, [interventionMode]);
  const missingKey =
    [...wantedVariants.map(keyFor), ...(todayKey ? [todayKey] : [])].find((key) => !fieldCache.has(key)) ?? null;
  // For the performance readout: the view isn't right until every field it
  // needs is there (waiting out the request delay included).
  useEffect(() => {
    if (status !== "ready" || missingKey === null) return;
    timeline.begin("field");
    return () => timeline.end("field");
  }, [status, missingKey]);

  useEffect(() => {
    if (status !== "ready" || missingKey === null) return;
    const [kt, month, day, asIs] = JSON.parse(missingKey) as [number, number, number, boolean];
    setThermalFailed(false);
    // Asked for only once the year and date have settled: stepping through
    // days or dragging the year would otherwise queue one computation per
    // step on the backend, and the last one would come after all of them.
    // One variant at a time; the next is asked for once this one lands.
    const timer = setTimeout(() => {
      fetchFieldIntoCache(missingKey, kt, month, day, asIs)
        .then(() => setFieldsFetched((n) => n + 1))
        .catch((err) => {
          console.error(err);
          setThermalFailed(true);
        });
    }, FIELD_REQUEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status, missingKey]);

  // Days likely to be asked for next, fetched ahead in the background once
  // the fields for the day shown are there: the same day of the months
  // either side (stepping through the months), then the preset days
  // (solstices, equinox). One click then shows its field at once.
  const haveWantedFields = wantedVariants.length > 0 && missingKey === null;
  const { month, day } = sunSetting;
  useEffect(() => {
    if (status !== "ready" || !haveWantedFields) return;
    let cancelled = false;
    const sameDay = (m: number) => ({ month: m, day: Math.min(day, new Date(2021, m, 0).getDate()) });
    const ahead = [sameDay((month % 12) + 1), sameDay(((month + 10) % 12) + 1), ...SEASON_PRESETS];
    (async () => {
      for (const asIs of JSON.parse(variantsKey) as boolean[]) {
        for (const next of ahead) {
          const key = fieldKey(t, next.month, next.day, asIs, interventionsKey);
          if (cancelled || fieldCache.has(key)) continue;
          await fetchFieldIntoCache(key, t, next.month, next.day, asIs)
            .then(() => setFieldsFetched((n) => n + 1))
            .catch(console.error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, haveWantedFields, t, month, day, variantsKey, interventionsKey]);

  const thermalLayer = useMemo(
    () => (thermalHeld ? layerAt(thermalHeld, sunSetting.hour) : null),
    [thermalHeld, sunSetting.hour]
  );

  const thermalStale = thermalHeld !== null && thermalHeld !== thermalField;
  const thermalShown = useMemo(
    () => (thermalHeld && thermalLayer ? { field: thermalHeld, layer: thermalLayer, stale: thermalStale } : null),
    [thermalHeld, thermalLayer, thermalStale]
  );


  // The 2D layer is only redrawn while the map is the view shown: behind the
  // 3D view, every date change would make the hidden map repaint for nothing
  // (with its extruded buildings, not cheap). Switching back catches up.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !scene || tab !== "2d") return;
    const shown = thermalShown;
    thermalLayerRef.current = shown;
    if (!shown) setThermalReading(null);
    setThermalLayer(map, anchorFromPolygon(scene.site_boundary), shown?.field ?? null, shown?.layer ?? null, shown?.stale);
  }, [thermalShown, scene, tab]);

  // The sun's height, for the day-and-hour control's readout.
  const sunAltitudeDeg = useMemo(() => {
    if (!scene) return 0;
    const anchor = anchorFromPolygon(scene.site_boundary);
    return sunPosition(sunSetting, CURRENT_YEAR + t, anchor.lat0, anchor.lng0).altitudeDeg;
  }, [scene, sunSetting, t]);

  function rearmDrawing() {
    // clear() throws if the instance is currently stopped (it is, after
    // "finish" paused it), so re-enable before clearing the drawn feature.
    drawRef.current?.start();
    drawRef.current?.clear();
    setPendingGeometry(null);
    setReplantTargetId(null);
    if (selectedCard) {
      const mode = modeForPlacementRef.current[selectedCard.placement_type];
      if (mode) drawRef.current?.setMode(mode);
    } else {
      drawRef.current?.stop();
    }
  }

  function handleViewTabChange(next: AppView) {
    if (next === tab) return;
    // Editing only happens on the 2D map: an armed card or an open form
    // would be left dangling out of sight, and a placard picked in 3D is
    // only carried over to 2D through its explicit "Modifica" button.
    setSelectedCard(null);
    setPendingGeometry(null);
    setReplantTargetId(null);
    setSelectedInterventionId(null);
    setSelectedTreeElementId(null);
    setTab(next);
  }

  /** From the 3D view's placard info card: straight into the edit form. */
  function handleEditInterventionIn2D(id: string) {
    setTab("2d");
    setSelectedInterventionId(id);
  }

  function handleSelectCard(card: CardSpec | null) {
    setSelectedInterventionId(null);
    setSelectedTreeElementId(null);
    setSelectedCard(card);
  }

  function handleSelectIntervention(id: string | null) {
    setSelectedCard(null);
    setPendingGeometry(null);
    setSelectedTreeElementId(null);
    setSelectedInterventionId(id);
  }

  function handleReplant(element: SceneResponse["elements"][number]) {
    const plantTreeCard = cards.find((c) => c.card_type === "plant_tree");
    if (!plantTreeCard) return;
    setSelectedTreeElementId(null);
    setSelectedInterventionId(null);
    setReplantTargetId(element.id);
    setSelectedCard(plantTreeCard);
    setPendingGeometry(element.geometry);
  }

  function handleUpdateIntervention(id: string, params: Record<string, unknown>) {
    timeline.markInput("card edited");
    timeline.begin("scene");
    updateIntervention(id, params, t)
      .then((scene) => {
        applyScene(scene);
        setSelectedInterventionId(null);
      })
      .catch((err) => {
        console.error(err);
        timeline.end("scene");
      });
  }

  function handleToggleIntervention(id: string, enabled: boolean) {
    timeline.markInput(enabled ? "card on" : "card off");
    timeline.begin("scene");
    setInterventionEnabled(id, enabled, t)
      .then(applyScene)
      .catch((err) => {
        console.error(err);
        timeline.end("scene");
      });
  }

  // A scenario loaded, or the cards cleared, from the "Scenari" menu.
  function handleSceneReplaced(newScene: SceneResponse, scenarioName?: string) {
    setLoadedScenario(scenarioName ? { name: scenarioName, cards: cardsKey(newScene.interventions) } : null);
    timeline.markInput("scenario loaded");
    timeline.begin("scene");
    // Numbered like a year change, so a year fetch still on its way doesn't
    // bring back the cards just replaced.
    ++timeRequestSeqRef.current;
    applyScene(newScene);
    setSelectedInterventionId(null);
    setSelectedTreeElementId(null);
  }

  function handleDeleteIntervention(id: string) {
    timeline.markInput("card removed");
    timeline.begin("scene");
    deleteIntervention(id, t)
      .then((scene) => {
        applyScene(scene);
        setSelectedInterventionId(null);
      })
      .catch((err) => {
        console.error(err);
        timeline.end("scene");
      });
  }

  function handleSubmit(params: Record<string, unknown>) {
    if (!pendingGeometry || !selectedCard || !mapRef.current) return;
    timeline.markInput("card added");
    timeline.begin("scene");
    createIntervention(
      { card_type: selectedCard.card_type, geometry: pendingGeometry, params, replaces_element_id: replantTargetId },
      t
    )
      .then((scene) => {
        applyScene(scene);
        rearmDrawing();
      })
      .catch((err) => {
        console.error(err);
        timeline.end("scene");
        // Past the boundary somewhere between the vertices the map checked.
        if (err instanceof HttpError && err.status === 422) {
          showNotice(outsideMessage());
          rearmDrawing();
        }
      });
  }

  function handleTimeChange(newT: number) {
    setT(newT);
    if (!mapRef.current) return;
    timeline.markInput("year");
    timeline.begin("scene");
    const requestSeq = ++timeRequestSeqRef.current;
    fetchScene(newT)
      .then((newScene) => {
        if (requestSeq !== timeRequestSeqRef.current) {
          timeline.end("scene"); // superseded by a later drag step
          return;
        }
        applyScene(newScene);
      })
      .catch((err) => {
        console.error(err);
        timeline.end("scene");
      });
  }

  const siteName = scene?.site_name;
  useEffect(() => {
    const { title } = activePack();
    document.title = siteName ? `${title} — ${siteName}` : title;
  }, [siteName]);

  // Another window (say, the projected one and the facilitator's) may have
  // changed the session: every few seconds while this one is visible, and
  // as soon as it comes back into view, ask whether anything changed (a
  // cheap call), and fetch the scene only if so.
  useEffect(() => {
    if (status !== "ready") return;
    let checking = false; // one check at a time, a slow one isn't doubled by the next tick
    function checkForChanges() {
      if (checking || document.visibilityState !== "visible") return;
      const shown = sceneRef.current;
      if (!shown) return;
      checking = true;
      fetchSessionRevision()
        .then(({ revision, notes: notesRevision, restart_needed, phase }) => {
          setRestartNeeded(restart_needed);
          notesRef.current.follow(notesRevision);
          // The manager moved the team to another phase: what may this window do now?
          if (phase !== phaseRef.current) refreshAccess();
          if (revision === shown.revision || sceneRef.current !== shown) return;
          // Numbered like a year change, so a slider drag in the meantime wins.
          const requestSeq = ++timeRequestSeqRef.current;
          timeline.markInput("session changed elsewhere");
          timeline.begin("scene");
          return fetchScene(t).then((newScene) => {
            if (requestSeq !== timeRequestSeqRef.current) {
              timeline.end("scene");
              return;
            }
            applyScene(newScene);
          }, (err) => {
            timeline.end("scene");
            throw err;
          });
        })
        .catch((err) => console.error(err))
        .finally(() => {
          checking = false;
        });
    }
    window.addEventListener("focus", checkForChanges);
    document.addEventListener("visibilitychange", checkForChanges);
    const poll = window.setInterval(checkForChanges, REVISION_POLL_MS);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("focus", checkForChanges);
      document.removeEventListener("visibilitychange", checkForChanges);
    };
  }, [status, t, refreshAccess]);

  const selectedIntervention = scene?.interventions.find((i) => i.id === selectedInterventionId) ?? null;
  const selectedInterventionCard = selectedIntervention
    ? cards.find((c) => c.card_type === selectedIntervention.card_type) ?? null
    : null;
  const selectedTreeElement = scene?.elements.find((e) => e.id === selectedTreeElementId) ?? null;

  // The panels wait for the view: none shown that it would hide.
  const ready = status === "ready" && views !== null;
  return (
    <div className="app">
      <header className="top-bar">
        <ViewTabs view={tab} tabs={viewTabs(screenView)} onChange={handleViewTabChange} />
        <div className="top-bar__right">
          {ready && tab !== "indicators" && shown("interventionMode") && (
            <InterventionsToggle mode={interventionMode} onChange={changeInterventionMode} />
          )}
          {ready && comparing && compared !== null && (
            <ComparisonPicker scenarios={scenarios} compared={compared} onChange={setCompared} onRefresh={refreshScenarios} />
          )}
          {ready && scene && shown("scenarios") && (
            <ScenarioMenu
              interventionCount={scene.interventions.length}
              disabledCount={scene.interventions.length - enabledInterventions.length}
              t={t}
              canClear={canEditInterventions}
              onSceneReplaced={handleSceneReplaced}
            />
          )}
          {access.mechanism === "pin" && <TeamBadge access={access} />}
          {activePack().features.thermal && <TempSwitch unit={tempUnit} />}
          <LangSwitch lang={lang} />
        </div>
      </header>
      <div
        ref={containerRef}
        className={selectedCard || notes.placing ? "map-container map-container--drawing" : "map-container"}
      />
      {status !== "ready" && (
        <div className="status-banner">
          {status === "loading"
            ? tr("Caricamento della scena di base…", "Loading the base scene…")
            : tr(
                "Impossibile caricare lo scenario di base — il backend è in esecuzione?",
                "Could not load the base scenario — is the backend running?"
              )}
        </div>
      )}
      {restartNeeded && (
        <div className="restart-banner" role="alert">
          {tr("L'app deve essere riavviata", "The app needs restarting")}
        </div>
      )}
      {notice && <div className={restartNeeded ? "map-notice map-notice--lower" : "map-notice"}>{notice}</div>}
      {ready && (
        <>
          {tab === "2d" && comparison && (
            <ComparisonView
              comparison={comparison}
              t={t}
              mode={interventionMode}
              cards={cards}
              descriptors={indicatorDescriptors}
              showKpi={shown("kpi")}
              initialFraming={mapRef.current ? readMapFraming(mapRef.current) : null}
              onLeave={(framing) => mapRef.current?.jumpTo(framing)}
              imageName={shown("export") ? () => pairImageName(comparison, "2d") : undefined}
            />
          )}
          {tab === "2d" && (
            <>
              {/* The current situation has no cards to place or list; the
                  notes may still be there. */}
              {((interventionMode !== "hidden" && (canPlace || shown("interventions"))) || shown("notes")) && (
                <div className="left-rail">
                  {shown("notes") && <NotesPanel notes={notes} />}
                  {interventionMode !== "hidden" && canPlace && (
                    <CardPalette
                      cards={cards}
                      selected={selectedCard}
                      onSelect={handleSelectCard}
                      initiallyCollapsed={initialDebugParams.panelsClosed}
                    />
                  )}
                  {interventionMode !== "hidden" && shown("interventions") && (
                    <InterventionList
                      interventions={scene?.interventions ?? []}
                      cards={cards}
                      onSelect={handleSelectIntervention}
                      onToggle={canEditInterventions ? handleToggleIntervention : undefined}
                      initiallyCollapsed={initialDebugParams.panelsClosed}
                    />
                  )}
                </div>
              )}
              {shown("legend") && <MapLegend />}
              {shown("export") && !comparison && (
                <button
                  type="button"
                  className="map-download"
                  onClick={downloadMapImage}
                  title={tr("Scarica la mappa come immagine", "Download the map as an image")}
                >
                  {tr("Scarica immagine", "Download image")}
                </button>
              )}
            </>
          )}
          {tab === "3d" && comparison && (
            <ComparisonView3D
              comparison={comparison}
              t={t}
              onTimeChange={handleTimeChange}
              showTime={shown("time")}
              mode={interventionMode}
              cards={cards}
              descriptors={indicatorDescriptors}
              showKpi={shown("kpi")}
              terrain={terrain}
              site={scene?.site_boundary ?? null}
              sunSetting={sunSetting}
              onSunSettingChange={changeSunSetting}
              initialView={
                mapRef.current && scene ? mapToView(mapRef.current, anchorFromPolygon(scene.site_boundary), terrainRef.current) : null
              }
              imageName={shown("export") ? () => pairImageName(comparison, "3d") : undefined}
            />
          )}
          {view3dMounted && (
            <View3D
              scene={scene}
              terrain={terrain}
              mode={interventionMode}
              cards={cards}
              active={tab === "3d" && !comparison}
              t={t}
              onTimeChange={handleTimeChange}
              showTime={shown("time")}
              imageName={shown("export") ? () => imageName("3d") : undefined}
              pose={cameraPose}
              onPlacePose={setCameraPose}
              onClearPose={() => setCameraPose(null)}
              onSelectIntervention={setSelectedInterventionId}
              notes={notes.drawn}
              onSelectNote={notes.select}
              sunSetting={sunSetting}
              onSunSettingChange={changeSunSetting}
              thermal={thermalShown}
              onThermalReading={setThermalReading}
              comfortField={comfortHeld}
              onCrowdExposure={setCrowdExposure}
              initialLifeMode={initialDebugParams.life ?? undefined}
              showPerf={initialDebugParams.perf}
              viewRef={view3dRef}
              initialView={initial3dView}
            />
          )}
          {/* Comparing, each pane has its own key indicators. */}
          {tab !== "indicators" && !comparison && (
            <div className="right-rail">
              {scene && indicatorDescriptors && shown("kpi") && <KpiPanel
                  descriptors={indicatorDescriptors}
                  indicators={scene.indicators}
                  baselineIndicators={scene.baseline_indicators}
                  deferred={kpiDeferred}
                  asIs={interventionMode === "hidden"}
                  initiallyCollapsed={initialDebugParams.panelsClosed}
                />}
              {thermalAllowed && (tab === "2d" || tab === "3d") && (
                <ThermalPanel
                  open={thermalPanelOpen}
                  onOpenChange={setThermalPanelOpen}
                  fieldShown={thermalOn}
                  onFieldShownChange={setThermalOn}
                  field={panelField}
                  loading={thermalLoading}
                  failed={thermalFailed}
                  hour={sunSetting.hour}
                  onHourChange={(hour) => changeSunSetting({ ...sunSetting, hour })}
                  reading={thermalOn ? thermalReading : null}
                  crowd={tab === "3d" ? crowdExposure : null}
                  curve={curveShown}
                />
              )}
              {(tab === "2d" || tab === "3d") && <NotesRail notes={notes} />}
              {tab === "2d" &&
                (pendingGeometry && selectedCard ? (
                  <ParamForm card={selectedCard} plantedYear={t} onSubmit={handleSubmit} onCancel={rearmDrawing} />
                ) : selectedIntervention && selectedInterventionCard && canPlace ? (
                  <ParamForm
                    card={selectedInterventionCard}
                    initialValues={selectedIntervention.params}
                    plantedYear={selectedIntervention.planted_year}
                    authors={selectedIntervention}
                    notice={
                      !selectedIntervention.enabled && (
                        <CardOffNotice
                          onEnable={canEditInterventions ? () => handleToggleIntervention(selectedIntervention.id, true) : undefined}
                        />
                      )
                    }
                    submitLabel={tr("Salva", "Save")}
                    onSubmit={(params) => handleUpdateIntervention(selectedIntervention.id, params)}
                    onCancel={() => setSelectedInterventionId(null)}
                    onDelete={() => handleDeleteIntervention(selectedIntervention.id)}
                  />
                ) : selectedIntervention ? (
                  <InterventionInfoCard
                    intervention={selectedIntervention}
                    card={selectedInterventionCard}
                    onEnable={canEditInterventions ? () => handleToggleIntervention(selectedIntervention.id, true) : undefined}
                    onClose={() => setSelectedInterventionId(null)}
                  />
                ) : selectedTreeElement ? (
                  <TreeIdentityCard
                    element={selectedTreeElement}
                    onClose={() => setSelectedTreeElementId(null)}
                    onReplant={canPlace ? () => handleReplant(selectedTreeElement) : undefined}
                  />
                ) : null)}
              {tab === "3d" && selectedIntervention && (
                <InterventionInfoCard
                  intervention={selectedIntervention}
                  card={selectedInterventionCard}
                  onEdit={canPlace ? () => handleEditInterventionIn2D(selectedIntervention.id) : undefined}
                  onEnable={canEditInterventions ? () => handleToggleIntervention(selectedIntervention.id, true) : undefined}
                  onClose={() => setSelectedInterventionId(null)}
                />
              )}
            </div>
          )}
          {tab === "indicators" && scene && indicatorDescriptors && (
            <IndicatorsView
              descriptors={indicatorDescriptors}
              interventions={enabledInterventions}
              // Hidden by the view, not by the switch (which this tab hasn't).
              asIs={!shown("interventionMode") && interventionMode === "hidden"}
              t={t}
              onTimeChange={handleTimeChange}
              comparison={comparison}
            />
          )}
          {/* In the 3D view the year is part of its own time panel, together
              with day and hour. */}
          {shown("time") &&
            (tab === "2d" && (thermalOn || thermalPanelOpen) ? (
              <div className="map-time-panel">
                <TimeSlider t={t} onChange={handleTimeChange} embedded />
                <SunControl
                  setting={sunSetting}
                  altitudeDeg={sunAltitudeDeg}
                  year={CURRENT_YEAR + t}
                  onChange={changeSunSetting}
                />
              </div>
            ) : (
              tab !== "3d" && <TimeSlider t={t} onChange={handleTimeChange} />
            ))}
        </>
      )}
    </div>
  );
}

export default App;
