/** Performance readout for the 3D view, shown with `?perf=1` in the URL.
 *
 * Live figures, plus a fixed benchmark ("Misura") that runs the same six
 * measurements on any machine — day and night, each with people and traffic
 * hidden, still and moving — so results from different workshop machines
 * can be compared. The camera slowly circles during the benchmark: at night,
 * camera movement is what makes the nearest streetlights re-render their
 * shadows, and a still camera would hide that cost.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import type { ViewerHandle } from "../three/Viewer";
import type { LifeMode } from "../three/people/activity";
import type { SunSetting } from "../three/sun";

type Reading = ReturnType<ViewerHandle["readPerf"]>;

interface Props {
  viewerRef: RefObject<ViewerHandle | null>;
  sunSetting: SunSetting;
  onSunSettingChange: (setting: SunSetting) => void;
  lifeMode: LifeMode;
  onLifeModeChange: (mode: LifeMode) => void;
}

// 21 June: the longest day, so 18:00 is broad daylight at the busiest hour
// and 22:30 is dark (streetlights on) everywhere in Italy.
const BENCHMARK_TIMES: { label: string; setting: SunSetting }[] = [
  { label: "Giorno (21/6 18:00)", setting: { month: 6, day: 21, hour: 18 } },
  { label: "Notte (21/6 22:30)", setting: { month: 6, day: 21, hour: 22.5 } },
];
const BENCHMARK_MODES: { mode: LifeMode; label: string }[] = [
  { mode: "off", label: "Nascosti" },
  { mode: "still", label: "Fermi" },
  { mode: "live", label: "In movimento" },
];
// The first run includes a scene rebuild (the benchmark's date may differ
// from the current one), and the first night run the shader recompilation
// when the streetlights switch on — hence longer settle times for both.
const FIRST_WARMUP_MS = 6000;
const FIRST_NIGHT_WARMUP_MS = 8000;
const WARMUP_MS = 3000;
const MEASURE_MS = 8000;

interface Row {
  time: string;
  mode: string;
  reading: Reading;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function machineInfo(): string {
  let gpu = "sconosciuta";
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    // Some browsers refuse; the rest of the report still stands.
  }
  return [
    `GPU: ${gpu}`,
    `Finestra: ${window.innerWidth}x${window.innerHeight}, pixel ratio ${window.devicePixelRatio}`,
    `CPU (thread logici): ${navigator.hardwareConcurrency ?? "?"}`,
    `Browser: ${navigator.userAgent}`,
  ].join("\n");
}

const f0 = (n: number) => n.toFixed(0);
const f1 = (n: number) => n.toFixed(1);

export function PerfPanel({ viewerRef, sunSetting, onSunSettingChange, lifeMode, onLifeModeChange }: Props) {
  const [live, setLive] = useState<Reading | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // Live figures, over the last half second — paused during a benchmark,
  // which needs the recorder to itself.
  useEffect(() => {
    if (running) return;
    const timer = setInterval(() => {
      const reading = viewerRef.current?.readPerf(true);
      if (reading && reading.frames > 0) setLive(reading);
    }, 500);
    return () => clearInterval(timer);
  }, [running, viewerRef]);

  async function runBenchmark() {
    const viewer = viewerRef.current;
    if (!viewer || running) return;
    const restore = { sun: sunSetting, life: lifeMode };
    const results: Row[] = [];
    setRows([]);
    viewer.setAutoRotate(true);
    let first = true;
    for (const [timeIndex, time] of BENCHMARK_TIMES.entries()) {
      for (const [modeIndex, mode] of BENCHMARK_MODES.entries()) {
        if (cancelledRef.current) return;
        setRunning(`${time.label} · ${mode.label}`);
        onSunSettingChange(time.setting);
        onLifeModeChange(mode.mode);
        const firstOfTime = modeIndex === 0 && timeIndex > 0;
        await sleep(first ? FIRST_WARMUP_MS : firstOfTime ? FIRST_NIGHT_WARMUP_MS : WARMUP_MS);
        first = false;
        viewer.readPerf(true);
        await sleep(MEASURE_MS);
        results.push({ time: time.label, mode: mode.label, reading: viewer.readPerf(true) });
        setRows([...results]);
      }
    }
    viewer.setAutoRotate(false);
    onSunSettingChange(restore.sun);
    onLifeModeChange(restore.life);
    setRunning(null);
  }

  async function copyResults() {
    const header = "Momento\tPersone e traffico\tFPS\tFrame ms (media)\tFrame ms (p95)\tCPU simulazione ms\tCPU disegno ms\tDraw call\tTriangoli\tPersone\tCani\tAuto";
    const lines = rows.map(({ time, mode, reading: r }) =>
      [time, mode, f1(r.fps), f1(r.frameMs), f1(r.frameP95Ms), f1(r.simMs), f1(r.renderMs), f0(r.calls), f0(r.triangles), r.people, r.dogs, r.cars].join("\t")
    );
    await navigator.clipboard.writeText([machineInfo(), "", header, ...lines].join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="perf-panel">
      <div className="perf-panel__live">
        {live ? (
          <>
            <strong>{f0(live.fps)} fps</strong> · frame {f1(live.frameMs)} ms (p95 {f1(live.frameP95Ms)}) · CPU sim{" "}
            {f1(live.simMs)} ms, disegno {f1(live.renderMs)} ms · {f0(live.calls)} draw call · {(live.triangles / 1e6).toFixed(2)} M
            triangoli · {live.people} persone, {live.dogs} cani, {live.cars} auto
          </>
        ) : (
          "Misurazione in corso…"
        )}
      </div>
      <div className="perf-panel__actions">
        <button type="button" onClick={runBenchmark} disabled={running !== null}>
          {running ? `Misura: ${running}…` : "Misura (giorno e notte, ~70 s)"}
        </button>
        {rows.length > 0 && !running && (
          <button type="button" onClick={copyResults}>
            {copied ? "Copiato!" : "Copia risultati"}
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <table className="perf-panel__table">
          <thead>
            <tr>
              <th>Momento</th>
              <th>Persone e traffico</th>
              <th>FPS</th>
              <th>Frame ms (p95)</th>
              <th>CPU sim</th>
              <th>CPU disegno</th>
              <th>Draw call</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.time}-${row.mode}`}>
                <td>{row.time}</td>
                <td>{row.mode}</td>
                <td>{f0(row.reading.fps)}</td>
                <td>
                  {f1(row.reading.frameMs)} ({f1(row.reading.frameP95Ms)})
                </td>
                <td>{f1(row.reading.simMs)}</td>
                <td>{f1(row.reading.renderMs)}</td>
                <td>{f0(row.reading.calls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
