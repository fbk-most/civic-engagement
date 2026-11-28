import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MapLibreMap } from "maplibre-gl";
import { fetchDeferredIndicators, fetchScene } from "../api/client";
import type {
  CardSpec,
  DeferredIndicators,
  IndicatorDescriptors,
  InterventionDisplayMode,
  SceneResponse,
} from "../api/types";
import type { ComparedSource, Side } from "../comparison";
import { createMap } from "../map/mapSetup";
import { renderScene } from "../map/layers";
import { tr } from "../i18n/lang";
import type { MapFraming } from "../map/viewSync";
import { KpiPanel } from "./KpiPanel";

interface Props {
  side: Side;
  source: ComparedSource;
  t: number;
  mode: InterventionDisplayMode;
  descriptors: IndicatorDescriptors | null;
  /** Its key indicators shown (the view's `kpi` panel). */
  showKpi: boolean;
  /** What shows the scene: a map (`PaneMap`) or a 3D view. */
  children: (scene: SceneResponse | null) => ReactNode;
}

/** One side of a comparison: a scenario's scene (the current one or a
 * saved one) shown read-only, its name, and its key indicators. Nothing on
 * it is placed or changed: that is the other views'. */
export function ScenarioPane({ side, source, t, mode, descriptors, showKpi, children }: Props) {
  const [scene, setScene] = useState<SceneResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [deferred, setDeferred] = useState<DeferredIndicators | null>(null);

  // The scene at the year shown: again when the year changes, or what the
  // side shows (another scenario, the current scene's cards changed).
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetchScene(t, source.scenario)
      .then((next) => {
        if (!cancelled) setScene(next);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // `source.key` says when what `source.scenario` shows has changed.
  }, [t, source.scenario, source.key]);

  // Its deferred indicators (the thermal ones), apart: the scene needn't wait.
  useEffect(() => {
    if (!showKpi) return;
    let cancelled = false;
    setDeferred(null);
    fetchDeferredIndicators(t, source.scenario)
      .then((next) => {
        if (!cancelled) setDeferred(next);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [showKpi, t, source.scenario, source.key]);

  return (
    <div className={`scenario-pane scenario-pane--${side}`}>
      {children(scene)}
      <div className="scenario-pane__title">
        <span className={`comparison-picker__letter comparison-picker__letter--${side}`}>{side.toUpperCase()}</span>
        {source.label}
      </div>
      {failed && <div className="scenario-pane__status">{tr("Impossibile caricare lo scenario", "Could not load the scenario")}</div>}
      {showKpi && scene && descriptors && (
        <div className="scenario-pane__kpi">
          <KpiPanel
            descriptors={descriptors}
            indicators={scene.indicators}
            baselineIndicators={scene.baseline_indicators}
            deferred={deferred}
            asIs={mode === "hidden"}
          />
        </div>
      )}
    </div>
  );
}

/** A pane's read-only map. */
export function PaneMap({
  side,
  scene,
  mode,
  cards,
  initialFraming,
  onMap,
}: {
  side: Side;
  scene: SceneResponse | null;
  mode: InterventionDisplayMode;
  cards: CardSpec[];
  /** Where the camera starts: the main map's, so the comparison opens on
   * the place being looked at. Null: the site, as the main map frames it. */
  initialFraming: MapFraming | null;
  /** The map, once it's loaded and shows its first scene: for moving the
   * cameras together and for the pair's image (ComparisonView). */
  onMap: (side: Side, map: MapLibreMap | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Read when the map is first drawn, not followed.
  const initialFramingRef = useRef(initialFraming);
  const onMapRef = useRef(onMap);
  onMapRef.current = onMap;

  // The map, for as long as the pane is there.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = createMap(containerRef.current);
    mapRef.current = map;
    map.on("error", (e) => console.error("MapLibre error:", e.error));
    map.on("load", () => setLoaded(true));
    return () => {
      onMapRef.current(side, null);
      map.remove();
      mapRef.current = null;
    };
  }, [side]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !scene) return;
    const first = !map.getLayer("covers-fill");
    renderScene(map, scene, mode, cards);
    if (first) {
      // renderScene frames the site the first time; the main map's place
      // instead, if it had one.
      if (initialFramingRef.current) map.jumpTo(initialFramingRef.current);
      onMapRef.current(side, map);
    }
  }, [loaded, scene, mode, cards, side]);

  return <div ref={containerRef} className="scenario-pane__map" />;
}
