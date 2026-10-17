import { useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { CardSpec, InterventionDisplayMode, SceneResponse } from "../api/types";
import { Viewer, type ViewerHandle } from "../three/Viewer";
import { anchorFromPolygon } from "../three/geo";
import type { ThermalField, ThermalReading } from "../thermal/field";
import type { CrowdExposure } from "../three/people/comfort";
import { CURRENT_YEAR, seasonState, sunPosition, type SunSetting } from "../three/sun";
import type { CameraPose } from "../three/camera";
import { buildDebugUrl, readDebugParams } from "../debugParams";
import { SunControl } from "./SunControl";
import { TimeSlider } from "./TimeSlider";
import { MiniMap, type MiniMapHandle } from "./MiniMap";
import { crowdActivity, type LifeMode } from "../three/people/activity";
import { PerfPanel } from "./PerfPanel";
import { tr } from "../i18n/lang";

interface View3DProps {
  scene: SceneResponse | null;
  mode: InterventionDisplayMode;
  cards: CardSpec[];
  /** False while another tab is showing: the view stays mounted (rebuilding
   * the 3D scene, trees included, is too slow to redo on every tab switch)
   * but stops rendering. */
  active: boolean;
  /** Scenario year offset — the same shared value as the other tabs' slider. */
  t: number;
  onTimeChange: (t: number) => void;
  pose: CameraPose | null;
  onPlacePose: (pose: CameraPose) => void;
  /** Drops the placed viewpoint, back to the overview. */
  onClearPose: () => void;
  /** A placard was clicked ("Carte proposte" mode). */
  onSelectIntervention: (id: string) => void;
  /** Day and hour for the sun — owned by the app, since the 2D map's
   * felt-temperature layer follows them too. */
  sunSetting: SunSetting;
  onSunSettingChange: (setting: SunSetting) => void;
  /** The felt-temperature field at the hour shown, or null when it's off. */
  thermal?: { field: ThermalField; layer: Float32Array; stale: boolean } | null;
  onThermalReading?: (reading: ThermalReading) => void;
  /** The felt-temperature field of the scene built, read at the hour shown
   * in half-hour steps: people react to it unless `?comfort=off`, and are
   * measured against it (`onCrowdExposure`). Null until it's fetched. */
  comfortField?: ThermalField | null;
  onCrowdExposure?: (exposure: CrowdExposure | null) => void;
  /** From `?life=` in the URL (see debugParams.ts). */
  initialLifeMode?: LifeMode;
  /** `?perf=1`: the performance readout. */
  showPerf?: boolean;
  /** Reading and setting the camera, to keep the 2D map aligned with it
   * across tab switches (see map/viewSync.ts). */
  viewRef?: Ref<View3DViewHandle>;
  /** The 2D map's framing, to open on the first time (see `viewRef`). */
  initialView?: CameraPose | null;
}

export type View3DViewHandle = Pick<ViewerHandle, "readView" | "showView">;

// `?comfort=off`: URL-only, so read once, and carried over as it came in.
const COMFORT_REACT = readDebugParams().comfort;

const LIFE_LABELS: Record<LifeMode, { label: () => string; title: () => string }> = {
  off: {
    label: () => tr("Nascosti", "Hidden"),
    title: () => tr("Solo lo spazio, senza persone, animali e auto", "Only the space, without people, animals and cars"),
  },
  still: {
    label: () => tr("Fermi", "Still"),
    title: () => tr("Persone e traffico fermi, come in una fotografia", "People and traffic stopped, as in a photograph"),
  },
  live: {
    label: () => tr("In movimento", "Moving"),
    title: () => tr("Persone che camminano e auto che circolano", "People walking and cars driving around"),
  },
};

/** The "Vista 3D" tab: the realistic view, full-size, with a plan mini-map
 * for placing the viewpoint and one panel for year, day and hour. */
export function View3D({
  scene,
  mode,
  cards,
  active,
  t,
  onTimeChange,
  pose,
  onPlacePose,
  onClearPose,
  onSelectIntervention,
  sunSetting,
  onSunSettingChange: setSunSetting,
  thermal = null,
  onThermalReading,
  comfortField = null,
  onCrowdExposure,
  initialLifeMode,
  showPerf = false,
  viewRef,
  initialView,
}: View3DProps) {
  const [lifeMode, setLifeMode] = useState<LifeMode>(initialLifeMode ?? "live");
  const [urlCopied, setUrlCopied] = useState(false);
  const viewerRef = useRef<ViewerHandle>(null);
  const miniMapRef = useRef<MiniMapHandle>(null);
  // Tracks orbiting/walking, unlike `pose` (only the originally *placed*
  // viewpoint) — "Copia URL vista" should reproduce wherever the facilitator
  // actually ended up looking, not just where they started. A ref, not
  // state: it updates ~10x/second and nothing here needs to re-render for it.
  const livePoseRef = useRef<CameraPose | null>(pose);

  useImperativeHandle(viewRef, () => ({
    readView: () => viewerRef.current?.readView() ?? null,
    showView: (view: CameraPose) => viewerRef.current?.showView(view),
  }));

  // The calendar year always follows the scenario slider (t years from now),
  // not an independent choice — see three/sun.ts's module doc.
  const year = CURRENT_YEAR + (scene?.t ?? 0);

  // The sun is computed for the site's own latitude/longitude, so shade angles
  // are the site's rather than a generic mid-latitude approximation.
  const sun = useMemo(() => {
    const anchor = scene ? anchorFromPolygon(scene.site_boundary) : null;
    return sunPosition(sunSetting, year, anchor?.lat0 ?? 46.0712, anchor?.lng0 ?? 11.1205);
  }, [scene, sunSetting, year]);

  // Memoized (not recomputed inline in the JSX below) so Viewer's rebuild
  // effect — which depends on this object by reference — doesn't fire on
  // every unrelated re-render, only when the month actually changes.
  const season = useMemo(() => seasonState(sunSetting.month), [sunSetting.month]);

  const activity = crowdActivity(sunSetting, sun.altitudeDeg);
  // Half-hour steps, like the activity level's: dragging the hour slider
  // doesn't replan the crowd on every pixel.
  const comfortHour = Math.round(sunSetting.hour * 2) / 2;
  const comfort = useMemo(
    () => (comfortField ? { field: comfortField, hour: comfortHour, react: COMFORT_REACT } : null),
    [comfortField, comfortHour]
  );

  function handleViewChange(nextPose: CameraPose, cameraMode: "orbit" | "walk") {
    livePoseRef.current = nextPose;
    // Orbiting the overview with no viewpoint placed isn't "standing
    // somewhere" — the camera is off-site and high up, and a wedge drawn from
    // it would mislead rather than inform. Walking always counts.
    if (cameraMode === "orbit" && !pose) return;
    miniMapRef.current?.setLiveView(nextPose);
  }

  function handlePlacePose(placed: CameraPose) {
    livePoseRef.current = placed;
    onPlacePose(placed);
  }

  function handleClearPose() {
    viewerRef.current?.showOverview();
    livePoseRef.current = null;
    miniMapRef.current?.setLiveView(null);
    onClearPose();
  }

  /** Copies a URL that reproduces exactly this scenario year, sun position,
   * and camera pose — the point being to hand a rendering problem to someone
   * (or something) else without a screenshot-and-describe round trip. */
  async function handleCopyUrl() {
    const url = buildDebugUrl({
      t: scene?.t ?? 0,
      sun: sunSetting,
      pose: livePoseRef.current ?? pose,
      life: lifeMode,
      comfort: COMFORT_REACT,
      interventionMode: mode,
    });
    await navigator.clipboard.writeText(url);
    setUrlCopied(true);
    setTimeout(() => setUrlCopied(false), 1500);
  }

  return (
    <div className="view-3d" hidden={!active}>
      <Viewer
        scene={scene}
        mode={mode}
        cards={cards}
        onSelectIntervention={onSelectIntervention}
        handleRef={viewerRef}
        active={active}
        sun={sun}
        season={season}
        pose={pose}
        t={scene?.t ?? 0}
        onViewChange={handleViewChange}
        crowdActivity={activity}
        lifeMode={lifeMode}
        initialView={initialView}
        thermal={thermal}
        onThermalReading={onThermalReading}
        comfort={comfort}
        onCrowdExposure={onCrowdExposure}
      />
      <div className="view-3d__left">
        <MiniMap
          handleRef={miniMapRef}
          scene={scene}
          mode={mode}
          cards={cards}
          pose={pose}
          onPlacePose={handlePlacePose}
          onClearPose={handleClearPose}
        />
        <div className="view-3d__tools">
          <button
            type="button"
            onClick={() => viewerRef.current?.captureFrame()}
            title={tr("Salva questa vista come immagine", "Save this view as an image")}
          >
            {tr("Salva immagine", "Save image")}
          </button>
          <button type="button" onClick={handleCopyUrl} title={tr("Copia un link che riproduce esattamente questa vista", "Copy a link that reproduces exactly this view")}
          >
            {urlCopied ? tr("Copiato!", "Copied!") : tr("Copia URL vista", "Copy view URL")}
          </button>
        </div>
        <div className="view-3d__life" role="group" aria-label={tr("Persone e traffico", "People and traffic")}>
          <span>{tr("Persone e traffico", "People and traffic")}</span>
          <div>
            {(Object.keys(LIFE_LABELS) as LifeMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={lifeMode === mode}
                title={LIFE_LABELS[mode].title()}
                onClick={() => setLifeMode(mode)}
              >
                {LIFE_LABELS[mode].label()}
              </button>
            ))}
          </div>
        </div>
        {showPerf && (
          <PerfPanel
            viewerRef={viewerRef}
            sunSetting={sunSetting}
            onSunSettingChange={setSunSetting}
            lifeMode={lifeMode}
            onLifeModeChange={setLifeMode}
            year={t}
            onYearChange={onTimeChange}
          />
        )}

      </div>
      {/* A realistic image of a proposal is easily read, in a workshop, as a
          promise about what will be built. The caption is there to keep the
          status of the picture honest and stays visible at all times. */}
      <span className="view-3d__caption">{tr("Visualizzazione indicativa", "Indicative visualisation")}</span>
      <div className="view-3d__time">
        <TimeSlider t={t} onChange={onTimeChange} embedded />
        <SunControl setting={sunSetting} altitudeDeg={sun.altitudeDeg} year={year} onChange={setSunSetting} />
      </div>
    </div>
  );
}
