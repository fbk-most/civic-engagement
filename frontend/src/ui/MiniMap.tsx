import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { MapLibreMap } from "maplibre-gl";
import type { CardSpec, InterventionDisplayMode, SceneResponse } from "../api/types";
import { createMap } from "../map/mapSetup";
import { renderScene, setCameraView } from "../map/layers";
import { anchorFromPolygon } from "../three/geo";
import { frustumWedge, poseFromPoints, type CameraPose } from "../three/camera";
import { tr } from "../i18n/lang";

export interface MiniMapHandle {
  /** Where the 3D camera is right now, or null to fall back to the placed
   * pose. Called ~10x a second while orbiting/walking, so it draws straight
   * onto the map instead of going through React state. */
  setLiveView: (pose: CameraPose | null) => void;
}

interface Props {
  scene: SceneResponse | null;
  mode: InterventionDisplayMode;
  cards: CardSpec[];
  pose: CameraPose | null;
  onPlacePose: (pose: CameraPose) => void;
  onClearPose: () => void;
  handleRef?: Ref<MiniMapHandle>;
}

/** Plan view inside the 3D tab: shows where the 3D camera stands and what it
 * looks at, and is where a viewpoint gets placed — two clicks, where you
 * stand then which way you look. Same layers as the 2D tab, drawn flat and
 * north-up. */
export function MiniMap({ scene, mode, cards, pose, onPlacePose, onClearPose, handleRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Same StrictMode guard as App's main map: a second MapLibre instance
  // created while the first is still initialising never finishes loading.
  const initializedRef = useRef(false);
  const mapRef = useRef<MapLibreMap | null>(null);
  const loadedRef = useRef(false);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const renderInputsRef = useRef({ mode, cards });
  renderInputsRef.current = { mode, cards };
  const poseRef = useRef(pose);
  poseRef.current = pose;
  const livePoseRef = useRef<CameraPose | null>(null);
  const placingRef = useRef(false);
  const originRef = useRef<[number, number] | null>(null);
  const onPlacePoseRef = useRef(onPlacePose);
  onPlacePoseRef.current = onPlacePose;

  const [collapsed, setCollapsed] = useState(false);
  const [large, setLarge] = useState(false);
  const [placing, setPlacing] = useState(false);

  function drawView() {
    const map = mapRef.current;
    const currentScene = sceneRef.current;
    if (!map || !loadedRef.current || !currentScene) return;
    const shown = livePoseRef.current ?? poseRef.current;
    if (!shown) {
      setCameraView(map, null);
      return;
    }
    const anchor = anchorFromPolygon(currentScene.site_boundary);
    setCameraView(map, { wedge: frustumWedge(anchor, shown), position: [shown.lng, shown.lat] });
  }

  function render() {
    const map = mapRef.current;
    const currentScene = sceneRef.current;
    if (!map || !loadedRef.current || !currentScene) return;
    const { mode: currentMode, cards: currentCards } = renderInputsRef.current;
    renderScene(map, currentScene, currentMode, currentCards, { pitch: 0, bearing: 0, padding: 10 });
    // renderScene resets the camera source, so the wedge goes back on top.
    drawView();
  }

  useImperativeHandle(handleRef, () => ({
    setLiveView(livePose) {
      livePoseRef.current = livePose;
      if (!placingRef.current) drawView();
    },
  }));

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    const map = createMap(containerRef.current, { interactive3d: false });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.on("error", (e) => console.error("MapLibre (mini-map) error:", e.error));
    map.on("load", () => {
      loadedRef.current = true;
      render();
    });

    map.on("click", (e) => {
      const currentScene = sceneRef.current;
      if (!placingRef.current || !currentScene) return;
      const point: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      if (!originRef.current) {
        originRef.current = point;
        return;
      }
      const placed = poseFromPoints(anchorFromPolygon(currentScene.site_boundary), originRef.current, point);
      originRef.current = null;
      livePoseRef.current = null; // a new placement supersedes where we'd walked to
      setPlacing(false);
      onPlacePoseRef.current(placed);
    });

    map.on("mousemove", (e) => {
      const origin = originRef.current;
      const currentScene = sceneRef.current;
      if (!placingRef.current || !origin || !currentScene) return;
      const anchor = anchorFromPolygon(currentScene.site_boundary);
      const preview = poseFromPoints(anchor, origin, [e.lngLat.lng, e.lngLat.lat]);
      setCameraView(map, { wedge: frustumWedge(anchor, preview), position: origin });
    });
  }, []);

  useEffect(() => {
    render();
  }, [scene, mode, cards]);

  useEffect(() => {
    drawView();
  }, [pose]);

  // Re-frame the site whenever the map changes size, so enlarging it shows
  // the square bigger rather than just more of the surroundings.
  useEffect(() => {
    const map = mapRef.current;
    const currentScene = sceneRef.current;
    if (!map || !loadedRef.current || !currentScene || collapsed) return;
    map.resize();
    const ring = currentScene.site_boundary.coordinates[0];
    const lngs = ring.map((c) => c[0]);
    const lats = ring.map((c) => c[1]);
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 10, duration: 0 }
    );
  }, [large, collapsed]);

  useEffect(() => {
    placingRef.current = placing;
    if (mapRef.current) mapRef.current.getCanvas().style.cursor = placing ? "crosshair" : "";
    if (!placing) {
      originRef.current = null;
      drawView();
      return;
    }
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlacing(false);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [placing]);

  return (
    <div className={large ? "mini-map mini-map--large" : "mini-map"}>
      <div className="mini-map__header">
        <button type="button" className="panel-header" onClick={() => setCollapsed((c) => !c)}>
          <h3>{tr("Mappa", "Map")}</h3>
          <span className="panel-header__chevron">{collapsed ? "▸" : "▾"}</span>
        </button>
        {!collapsed && (
          <button
            type="button"
            className="mini-map__size"
            onClick={() => setLarge((l) => !l)}
            title={large ? tr("Riduci la mappa", "Shrink the map") : tr("Ingrandisci la mappa", "Enlarge the map")}
          >
            {large ? tr("Riduci", "Shrink") : tr("Ingrandisci", "Enlarge")}
          </button>
        )}
      </div>
      {/* Hidden rather than unmounted, so the map keeps its instance and
          its pan/zoom across collapsing. */}
      <div ref={containerRef} className="mini-map__map" hidden={collapsed} />
      {!collapsed && (
        <>
          {placing && (
            <p className="mini-map__hint">
              {tr(
                "Clicca dove ti trovi, poi nella direzione in cui guardi · Esc per annullare",
                "Click where you stand, then in the direction you look · Esc to cancel"
              )}
            </p>
          )}
          <div className="mini-map__actions">
            <button type="button" aria-pressed={placing} onClick={() => setPlacing((p) => !p)}>
              {placing ? tr("Annulla", "Cancel") : tr("Posiziona un punto di vista", "Place a viewpoint")}
            </button>
            {!placing && (
              <button type="button" onClick={onClearPose}>
                {tr("Vista d'insieme", "Overview")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
