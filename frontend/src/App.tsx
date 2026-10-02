import { useEffect, useRef, useState } from "react";
import type { MapLibreMap } from "maplibre-gl";
import type { TerraDraw } from "terra-draw";
import "maplibre-gl/dist/maplibre-gl.css";
import "./App.css";
import { createMap } from "./map/mapSetup";
import { renderScene, setCameraView, setHighlight } from "./map/layers";
import { mapToView, readMapFraming, sameFraming, sameView, viewToMap, type MapFraming } from "./map/viewSync";
import { frustumWedge, type CameraPose } from "./three/camera";
import { anchorFromPolygon } from "./three/geo";
import { readDebugParams } from "./debugParams";
import { createDraw } from "./map/terraDrawSetup";
import { createIntervention, deleteIntervention, fetchCards, fetchScene, updateIntervention } from "./api/client";
import type { CardSpec, InterventionDisplayMode, PlacementType, SceneResponse } from "./api/types";
import { CardPalette } from "./ui/CardPalette";
import { ParamForm } from "./ui/ParamForm";
import { TimeSlider } from "./ui/TimeSlider";
import { IndicatorsView } from "./ui/IndicatorsView";
import { KpiPanel } from "./ui/KpiPanel";
import { InterventionsToggle } from "./ui/InterventionsToggle";
import { InterventionList } from "./ui/InterventionList";
import { TreeIdentityCard } from "./ui/TreeIdentityCard";
import { MapLegend } from "./ui/MapLegend";
import { InterventionInfoCard } from "./ui/InterventionInfoCard";
import { View3D, type View3DViewHandle } from "./ui/View3D";
import { ViewTabs, type AppView } from "./ui/ViewTabs";

type Status = "loading" | "ready" | "error";

// Read once at module load, not per render — the query string doesn't change
// during the app's lifetime, and this seeds several independent pieces of
// initial state below (scenario year, camera pose, which view opens first).
const initialDebugParams = readDebugParams();

function App() {
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
  const interventionModeRef = useRef<InterventionDisplayMode>("simulated");
  const cardsRef = useRef<CardSpec[]>([]);
  const selectedCardRef = useRef<CardSpec | null>(null);

  const [status, setStatus] = useState<Status>("loading");
  const [cards, setCards] = useState<CardSpec[]>([]);
  cardsRef.current = cards;
  const [selectedCard, setSelectedCard] = useState<CardSpec | null>(null);
  const [pendingGeometry, setPendingGeometry] = useState<GeoJSON.Geometry | null>(null);
  const [t, setT] = useState(initialDebugParams.t ?? 0);
  const [scene, setScene] = useState<SceneResponse | null>(null);
  const [interventionMode, setInterventionMode] = useState<InterventionDisplayMode>("simulated");
  const [selectedInterventionId, setSelectedInterventionId] = useState<string | null>(null);
  const [selectedTreeElementId, setSelectedTreeElementId] = useState<string | null>(null);
  const [replantTargetId, setReplantTargetId] = useState<string | null>(null);
  const [view, setView] = useState<AppView>(initialDebugParams.viewerOpen ? "3d" : "2d");
  // The 3D view is only created the first time its tab is opened (no point
  // building trees nobody looks at), then kept alive across tab switches.
  const [view3dMounted, setView3dMounted] = useState(view === "3d");
  const [cameraPose, setCameraPose] = useState<CameraPose | null>(initialDebugParams.pose);
  // Keeping the map and the 3D view on the same framing across tab switches
  // (see map/viewSync.ts): what each showed right after the last alignment,
  // so a view that hasn't been moved since isn't disturbed.
  const view3dRef = useRef<View3DViewHandle>(null);
  const previousViewRef = useRef<AppView>(view);
  const alignedRef = useRef<{ map: MapFraming; view: CameraPose } | null>(null);
  const [initial3dView, setInitial3dView] = useState<CameraPose | null>(null);
  // The 3D field of view drawn on the map after leaving an eye-level view;
  // renderScene clears it, so it's redrawn after every render.
  const mapWedgeRef = useRef<Parameters<typeof setCameraView>[1]>(null);
  function renderMap(map: MapLibreMap, newScene: SceneResponse, mode: InterventionDisplayMode) {
    renderScene(map, newScene, mode, cardsRef.current);
    setCameraView(map, mapWedgeRef.current);
  }
  function applyScene(newScene: SceneResponse) {
    sceneRef.current = newScene;
    setScene(newScene);
    if (mapRef.current) renderMap(mapRef.current, newScene, interventionModeRef.current);
  }

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    const map = createMap(containerRef.current);
    mapRef.current = map;
    map.on("error", (e) => console.error("MapLibre error:", e.error));

    map.on("load", () => {
      // Matches `t`'s own initial state (see initialDebugParams above) rather
      // than a bare 0, or a `?t=5` debug URL would show the slider at 5 while
      // actually rendering the t=0 scenario until the slider was touched.
      fetchScene(initialDebugParams.t ?? 0)
        .then((scene) => {
          applyScene(scene);
          setStatus("ready");
        })
        .catch((err) => {
          console.error(err);
          setStatus("error");
        });

      const { draw, modeForPlacement } = createDraw(map);
      drawRef.current = draw;
      modeForPlacementRef.current = modeForPlacement;
      draw.on("finish", (id) => {
        const feature = draw.getSnapshotFeature(id);
        if (feature) {
          setPendingGeometry(feature.geometry);
          draw.stop();
        }
      });

      // Makes every tree (baseline or placed) clickable: baseline trees open
      // a read-only identity card, placed trees jump to their existing
      // intervention edit flow (selected via the InterventionList already).
      map.on("mouseenter", "trees-circle", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "trees-circle", () => {
        map.getCanvas().style.cursor = "";
      });
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
        if (selectedCardRef.current) return;
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
        "benches-circle",
        "streetlights-circle",
        "pergolas-circle",
        "kiosks-circle",
        "playgrounds-circle",
        "fitness-areas-circle",
        "paths-line",
        "covers-fill",
      ];
      for (const layerId of SELECTABLE_LAYERS) {
        map.on("mouseenter", layerId, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = "";
        });
        map.on("click", layerId, (e) => {
          if (selectedCardRef.current) return;
          const feature = e.features?.[0];
          if (!feature) return;
          const props = feature.properties as { source?: string; interventionId?: string | null };
          if (props.source !== "intervention" || !props.interventionId) return;
          setPendingGeometry(null);
          setSelectedTreeElementId(null);
          setSelectedInterventionId(props.interventionId);
        });
      }
      map.on("click", "trees-circle", (e) => {
        // Ignore tree clicks while a card is armed for drawing/placement —
        // otherwise a click that happens to land on a tree hijacks it into
        // opening that tree's identity card instead, silently derailing
        // whatever the facilitator was doing.
        if (selectedCardRef.current) return;
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
      });

      fetchCards().then(setCards).catch(console.error);
    });
  }, []);

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

  useEffect(() => {
    interventionModeRef.current = interventionMode;
    if (mapRef.current && sceneRef.current) {
      renderMap(mapRef.current, sceneRef.current, interventionMode);
    }
  }, [interventionMode]);

  // Tab switches carry the camera across: leaving 3D, the map takes the 3D
  // framing (or, from eye level, looks at the same place from above); coming
  // back, the 3D view takes the map's framing — each only if the other side
  // was actually moved since they were last aligned.
  useEffect(() => {
    const previous = previousViewRef.current;
    previousViewRef.current = view;
    const map = mapRef.current;
    const currentScene = sceneRef.current;
    if (previous === view || !map || !currentScene) return;
    const anchor = anchorFromPolygon(currentScene.site_boundary);
    const aligned = alignedRef.current;

    if (view === "2d") {
      const shown = view3dRef.current?.readView();
      if (!shown || (aligned && sameView(shown, aligned.view, anchor))) return;
      const { framing, eyeLevel } = viewToMap(map, anchor, shown);
      map.jumpTo(framing);
      mapWedgeRef.current = eyeLevel ? { wedge: frustumWedge(anchor, shown), position: [shown.lng, shown.lat] } : null;
      setCameraView(map, mapWedgeRef.current);
      alignedRef.current = { map: readMapFraming(map), view: shown };
    } else if (view === "3d") {
      const framing = readMapFraming(map);
      if (aligned && sameFraming(framing, aligned.map)) return;
      const next = mapToView(map, anchor);
      // The first time, the 3D view isn't there yet: it opens on this instead.
      if (view3dRef.current) view3dRef.current.showView(next);
      else setInitial3dView(next);
      alignedRef.current = { map: framing, view: next };
    }
  }, [view]);

  useEffect(() => {
    if (view === "3d") setView3dMounted(true);
  }, [view]);

  useEffect(() => {
    // Guard on `scene` (not just the map ref): the map object exists synchronously
    // after construction, but its style/sources aren't ready until the "load"
    // event — which is also when the first scene fetch resolves — so using
    // `scene` as the readiness signal avoids calling addSource too early.
    if (!mapRef.current || !scene) return;
    const iv = scene.interventions.find((i) => i.id === selectedInterventionId) ?? null;
    setHighlight(mapRef.current, iv ? iv.geometry : null);
  }, [selectedInterventionId, scene]);

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
    if (next === view) return;
    // Editing only happens on the 2D map: an armed card or an open form
    // would be left dangling out of sight, and a placard picked in 3D is
    // only carried over to 2D through its explicit "Modifica" button.
    setSelectedCard(null);
    setPendingGeometry(null);
    setReplantTargetId(null);
    setSelectedInterventionId(null);
    setSelectedTreeElementId(null);
    setView(next);
  }

  /** From the 3D view's placard info card: straight into the edit form. */
  function handleEditInterventionIn2D(id: string) {
    setView("2d");
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
    updateIntervention(id, params, t)
      .then((scene) => {
        applyScene(scene);
        setSelectedInterventionId(null);
      })
      .catch(console.error);
  }

  function handleDeleteIntervention(id: string) {
    deleteIntervention(id, t)
      .then((scene) => {
        applyScene(scene);
        setSelectedInterventionId(null);
      })
      .catch(console.error);
  }

  function handleSubmit(params: Record<string, unknown>) {
    if (!pendingGeometry || !selectedCard || !mapRef.current) return;
    createIntervention(
      { card_type: selectedCard.card_type, geometry: pendingGeometry, params, replaces_element_id: replantTargetId },
      t
    )
      .then((scene) => {
        applyScene(scene);
        rearmDrawing();
      })
      .catch(console.error);
  }

  function handleTimeChange(newT: number) {
    setT(newT);
    if (!mapRef.current) return;
    const requestSeq = ++timeRequestSeqRef.current;
    fetchScene(newT)
      .then((newScene) => {
        if (requestSeq !== timeRequestSeqRef.current) return; // superseded by a later drag step
        applyScene(newScene);
      })
      .catch(console.error);
  }

  const selectedIntervention = scene?.interventions.find((i) => i.id === selectedInterventionId) ?? null;
  const selectedInterventionCard = selectedIntervention
    ? cards.find((c) => c.card_type === selectedIntervention.card_type) ?? null
    : null;
  const selectedTreeElement = scene?.elements.find((e) => e.id === selectedTreeElementId) ?? null;

  return (
    <div className="app">
      <header className="top-bar">
        <ViewTabs view={view} onChange={handleViewTabChange} />
        {status === "ready" && view !== "indicators" && (
          <InterventionsToggle mode={interventionMode} onChange={setInterventionMode} />
        )}
      </header>
      <div
        ref={containerRef}
        className={selectedCard ? "map-container map-container--drawing" : "map-container"}
      />
      {status !== "ready" && (
        <div className="status-banner">
          {status === "loading"
            ? "Caricamento della scena di base…"
            : "Impossibile caricare lo scenario di base — il backend è in esecuzione?"}
        </div>
      )}
      {status === "ready" && (
        <>
          {view === "2d" && (
            <>
              <div className="left-rail">
                <CardPalette cards={cards} selected={selectedCard} onSelect={handleSelectCard} />
                <InterventionList interventions={scene?.interventions ?? []} cards={cards} onSelect={handleSelectIntervention} />
              </div>
              <MapLegend />
            </>
          )}
          {view3dMounted && (
            <View3D
              scene={scene}
              mode={interventionMode}
              cards={cards}
              active={view === "3d"}
              t={t}
              onTimeChange={handleTimeChange}
              pose={cameraPose}
              onPlacePose={setCameraPose}
              onClearPose={() => setCameraPose(null)}
              onSelectIntervention={setSelectedInterventionId}
              initialSunSetting={initialDebugParams.sun ?? undefined}
              initialLifeMode={initialDebugParams.life ?? undefined}
              showPerf={initialDebugParams.perf}
              viewRef={view3dRef}
              initialView={initial3dView}
            />
          )}
          {view !== "indicators" && (
            <div className="right-rail">
              {scene && <KpiPanel indicators={scene.indicators} baselineIndicators={scene.baseline_indicators} />}
              {view === "2d" &&
                (pendingGeometry && selectedCard ? (
                  <ParamForm card={selectedCard} plantedYear={t} onSubmit={handleSubmit} onCancel={rearmDrawing} />
                ) : selectedIntervention && selectedInterventionCard ? (
                  <ParamForm
                    card={selectedInterventionCard}
                    initialValues={selectedIntervention.params}
                    plantedYear={selectedIntervention.planted_year}
                    submitLabel="Salva"
                    onSubmit={(params) => handleUpdateIntervention(selectedIntervention.id, params)}
                    onCancel={() => setSelectedInterventionId(null)}
                    onDelete={() => handleDeleteIntervention(selectedIntervention.id)}
                  />
                ) : selectedTreeElement ? (
                  <TreeIdentityCard
                    element={selectedTreeElement}
                    onClose={() => setSelectedTreeElementId(null)}
                    onReplant={() => handleReplant(selectedTreeElement)}
                  />
                ) : null)}
              {view === "3d" && selectedIntervention && (
                <InterventionInfoCard
                  intervention={selectedIntervention}
                  card={selectedInterventionCard}
                  onEdit={() => handleEditInterventionIn2D(selectedIntervention.id)}
                  onClose={() => setSelectedInterventionId(null)}
                />
              )}
            </div>
          )}
          {view === "indicators" && scene && (
            <IndicatorsView interventions={scene.interventions} t={t} onTimeChange={handleTimeChange} />
          )}
          {/* In the 3D view the year is part of its own time panel, together
              with day and hour. */}
          {view !== "3d" && <TimeSlider t={t} onChange={handleTimeChange} />}
        </>
      )}
    </div>
  );
}

export default App;
