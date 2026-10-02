import { useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { CardSpec, InterventionDisplayMode, SceneResponse } from "../api/types";
import { Viewer, type ViewerHandle } from "../three/Viewer";
import { anchorFromPolygon } from "../three/geo";
import { CURRENT_YEAR, DEFAULT_SUN_SETTING, seasonState, sunPosition, type SunSetting } from "../three/sun";
import type { CameraPose } from "../three/camera";
import { buildDebugUrl } from "../debugParams";
import { SunControl } from "./SunControl";
import { TimeSlider } from "./TimeSlider";
import { MiniMap, type MiniMapHandle } from "./MiniMap";
import { crowdActivity, type LifeMode } from "../three/people/activity";
import { PerfPanel } from "./PerfPanel";

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
  /** From `?month=&day=&hour=` in the URL, so a shared debug link also
   * restores the sun position it was captured at. */
  initialSunSetting?: SunSetting;
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

const LIFE_LABELS: Record<LifeMode, { label: string; title: string }> = {
  off: { label: "Nascosti", title: "Solo lo spazio, senza persone, animali e auto" },
  still: { label: "Fermi", title: "Persone e traffico fermi, come in una fotografia" },
  live: { label: "In movimento", title: "Persone che camminano e auto che circolano" },
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
  initialSunSetting,
  initialLifeMode,
  showPerf = false,
  viewRef,
  initialView,
}: View3DProps) {
  const [sunSetting, setSunSetting] = useState<SunSetting>(initialSunSetting ?? DEFAULT_SUN_SETTING);
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
            title="Salva questa vista come immagine"
          >
            Salva immagine
          </button>
          <button type="button" onClick={handleCopyUrl} title="Copia un link che riproduce esattamente questa vista">
            {urlCopied ? "Copiato!" : "Copia URL vista"}
          </button>
        </div>
        <div className="view-3d__life" role="group" aria-label="Persone e traffico">
          <span>Persone e traffico</span>
          <div>
            {(Object.keys(LIFE_LABELS) as LifeMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={lifeMode === mode}
                title={LIFE_LABELS[mode].title}
                onClick={() => setLifeMode(mode)}
              >
                {LIFE_LABELS[mode].label}
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
          />
        )}

      </div>
      {/* A realistic image of a proposal is easily read, in a workshop, as a
          promise about what will be built. The caption is there to keep the
          status of the picture honest and stays visible at all times. */}
      <span className="view-3d__caption">Visualizzazione indicativa</span>
      <div className="view-3d__time">
        <TimeSlider t={t} onChange={onTimeChange} embedded />
        <SunControl setting={sunSetting} altitudeDeg={sun.altitudeDeg} year={year} onChange={setSunSetting} />
      </div>
    </div>
  );
}
