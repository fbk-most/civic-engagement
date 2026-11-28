import { useEffect, useMemo, useRef, useState } from "react";
import type { CardSpec, IndicatorDescriptors, InterventionDisplayMode, SceneResponse } from "../api/types";
import { SIDES, type ComparedSource, type Side } from "../comparison";
import { downloadCanvas, pairImage } from "../imageExport";
import { tr } from "../i18n/lang";
import { activePack } from "../pack";
import type { CameraPose } from "../three/camera";
import { anchorFromPolygon } from "../three/geo";
import { crowdActivity, type LifeMode } from "../three/people/activity";
import { CURRENT_YEAR, seasonState, sunPosition, type SunSetting } from "../three/sun";
import type { Terrain } from "../three/terrain";
import { Viewer, type ViewerHandle } from "../three/Viewer";
import { viewSettings } from "../three/viewSettings";
import { LifeSwitch } from "./LifeSwitch";
import { ScenarioPane } from "./ScenarioPane";
import { SunControl } from "./SunControl";
import { TimeSlider } from "./TimeSlider";

interface Props {
  comparison: Record<Side, ComparedSource>;
  t: number;
  onTimeChange: (t: number) => void;
  /** The year, day and hour (the view's `time` panel). */
  showTime: boolean;
  mode: InterventionDisplayMode;
  cards: CardSpec[];
  descriptors: IndicatorDescriptors | null;
  showKpi: boolean;
  /** The ground; nothing is built while it's null (not known yet). */
  terrain: Terrain | null;
  /** The site's boundary, for the sun's place in the sky. */
  site: SceneResponse["site_boundary"] | null;
  sunSetting: SunSetting;
  onSunSettingChange: (setting: SunSetting) => void;
  /** Where both views open: the main map's framing. */
  initialView: CameraPose | null;
  /** The pair's image file name; no button without it (no `export`). */
  imageName?: () => string;
}

/** The 3D tab of a comparison: A and B side by side, read-only, their
 * cameras moved together, drawn lighter than the single view (see
 * three/viewSettings.ts) — two views cost the graphics card about twice
 * one. One year, day and hour, one people-and-traffic switch, for both. */
export function ComparisonView3D({
  comparison,
  t,
  onTimeChange,
  showTime,
  mode,
  cards,
  descriptors,
  showKpi,
  terrain,
  site,
  sunSetting,
  onSunSettingChange,
  initialView,
  imageName,
}: Props) {
  const [settings] = useState(() => viewSettings(true));
  const hasLife = activePack().features.life;
  const [lifeMode, setLifeMode] = useState<LifeMode>(hasLife ? (settings.life ?? "live") : "off");
  const viewerA = useRef<ViewerHandle>(null);
  const viewerB = useRef<ViewerHandle>(null);
  const paneA = useRef<HTMLDivElement>(null);
  const paneB = useRef<HTMLDivElement>(null);
  const viewers = { a: viewerA, b: viewerB };
  const panes = { a: paneA, b: paneB };
  // Read when the views open, not followed.
  const [opening] = useState(initialView);

  const year = CURRENT_YEAR + t;
  const sun = useMemo(() => {
    const anchor = site ? anchorFromPolygon(site) : null;
    return sunPosition(sunSetting, year, anchor?.lat0 ?? 46.0712, anchor?.lng0 ?? 11.1205);
  }, [site, sunSetting, year]);
  const season = useMemo(() => seasonState(sunSetting.month), [sunSetting.month]);
  const activity = crowdActivity(sunSetting, sun.altitudeDeg);

  // The cameras together: the view last pressed, scrolled or typed on leads,
  // the other follows it every frame. Until then, B follows A (both open on
  // the same place, but B's build may finish later).
  useEffect(() => {
    const viewerOf = { a: viewerA, b: viewerB };
    let leader: Side = "a";
    const off: (() => void)[] = [];
    for (const [side, pane] of [["a", paneA.current], ["b", paneB.current]] as const) {
      if (!pane) continue;
      const lead = () => {
        leader = side;
      };
      const inputs = ["pointerdown", "wheel", "touchstart", "keydown"] as const;
      for (const input of inputs) pane.addEventListener(input, lead, { capture: true, passive: true });
      off.push(() => {
        for (const input of inputs) pane.removeEventListener(input, lead, { capture: true });
      });
    }
    let last = "";
    let frame = requestAnimationFrame(function follow() {
      frame = requestAnimationFrame(follow);
      const state = viewerOf[leader].current?.readCamera();
      const follower = viewerOf[leader === "a" ? "b" : "a"].current;
      if (!state || !follower) return;
      const key = JSON.stringify(state) + leader;
      if (key === last) return;
      last = key;
      follower.setCamera(state);
    });
    return () => {
      cancelAnimationFrame(frame);
      off.forEach((f) => f());
    };
  }, []);

  /** Both views as one picture, A on the left, each with its name. */
  function downloadPair() {
    if (!imageName) return;
    const a = viewers.a.current?.snapshot();
    const b = viewers.b.current?.snapshot();
    if (a && b) downloadCanvas(pairImage(a, b, comparison.a.label, comparison.b.label), imageName());
  }

  return (
    <div className="comparison-view comparison-view--3d">
      {SIDES.map((side) => (
        <ScenarioPane key={side} side={side} source={comparison[side]} t={t} mode={mode} descriptors={descriptors} showKpi={showKpi}>
          {(scene) => (
            <div ref={panes[side]} className="scenario-pane__map">
              <Viewer
                scene={scene}
                terrain={terrain}
                mode={mode}
                cards={cards}
                active
                sun={sun}
                season={season}
                pose={null}
                crowdActivity={activity}
                lifeMode={lifeMode}
                initialView={opening}
                settings={settings}
                handleRef={viewers[side]}
              />
            </div>
          )}
        </ScenarioPane>
      ))}
      <div className="comparison-view__tools">
        {hasLife && <LifeSwitch mode={lifeMode} onChange={setLifeMode} />}
        {imageName && (
          <button
            type="button"
            className="comparison-view__download"
            onClick={downloadPair}
            title={tr("Scarica i due scenari affiancati come un'immagine", "Download the two scenarios side by side as an image")}
          >
            {tr("Scarica immagine", "Download image")}
          </button>
        )}
      </div>
      <span className="view-3d__caption">{tr("Visualizzazione indicativa", "Indicative visualisation")}</span>
      {showTime && (
        <div className="view-3d__time">
          <TimeSlider t={t} onChange={onTimeChange} embedded />
          <SunControl setting={sunSetting} altitudeDeg={sun.altitudeDeg} year={year} onChange={onSunSettingChange} />
        </div>
      )}
    </div>
  );
}
