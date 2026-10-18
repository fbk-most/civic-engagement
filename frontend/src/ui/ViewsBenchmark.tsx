/** TEMPORARY — a benchmark for the rural terrain work (2c/2b): the frame
 * rate in three fixed views of Bocenago, by day, once each, with the camera
 * still. Remove (this file and its line in PerfPanel.tsx) once the work is
 * measured with the regular benchmarks. */

import { useState, type RefObject } from "react";
import type { ViewerHandle } from "../three/Viewer";
import type { CameraPose } from "../three/camera";
import type { SunSetting } from "../three/sun";

const SUN: SunSetting = { month: 6, day: 21, hour: 11 };
const EYE = { eyeHeight: 1.65, fovDeg: 60 };
const VIEWS: { label: string; pose: CameraPose | null }[] = [
  { label: "Overview", pose: null },
  { label: "Valley floor, looking east", pose: { lng: 10.759621, lat: 46.118331, bearingDeg: 90, pitchDeg: 5, ...EYE } },
  { label: "Mid-slope, looking west", pose: { lng: 10.775029, lat: 46.118542, bearingDeg: 270, pitchDeg: -5, ...EYE } },
];
const FIRST_WARMUP_MS = 6000;
const WARMUP_MS = 3000;
const MEASURE_MS = 8000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Reading = ReturnType<ViewerHandle["readPerf"]>;

export function ViewsBenchmark({
  viewerRef,
  sunSetting,
  onSunSettingChange,
}: {
  viewerRef: RefObject<ViewerHandle | null>;
  sunSetting: SunSetting;
  onSunSettingChange: (setting: SunSetting) => void;
}) {
  const [running, setRunning] = useState<string | null>(null);
  const [rows, setRows] = useState<{ label: string; reading: Reading }[]>([]);
  const [copied, setCopied] = useState(false);

  async function run() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const restore = sunSetting;
    const results: { label: string; reading: Reading }[] = [];
    onSunSettingChange(SUN);
    for (const [i, view] of VIEWS.entries()) {
      setRunning(view.label);
      if (view.pose) viewer.showView(view.pose);
      else viewer.showOverview();
      await sleep(i === 0 ? FIRST_WARMUP_MS : WARMUP_MS);
      viewer.readPerf(true);
      await sleep(MEASURE_MS);
      results.push({ label: view.label, reading: viewer.readPerf(true) });
      setRows([...results]);
    }
    onSunSettingChange(restore);
    setRunning(null);
  }

  async function copy() {
    const header = "View (21/6 11:00)\tFPS\tFrame ms (mean)\tFrame ms (p95)\tCPU render ms\tDraw calls\tTriangles";
    const lines = rows.map(({ label, reading: r }) =>
      [label, r.fps.toFixed(1), r.frameMs.toFixed(1), r.frameP95Ms.toFixed(1), r.renderMs.toFixed(1), r.calls.toFixed(0), r.triangles.toFixed(0)].join("\t")
    );
    await navigator.clipboard.writeText([header, ...lines].join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      <button type="button" onClick={run} disabled={running !== null}>
        {running ? `3 views: ${running}…` : "3 views (Bocenago, ~35 s)"}
      </button>
      {rows.length > 0 && !running && (
        <button type="button" onClick={copy}>
          {copied ? "Copied!" : "Copy 3 views"}
        </button>
      )}
    </>
  );
}
