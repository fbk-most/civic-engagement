/** Per-frame performance figures for the 3D view, for the `?perf=1`
 * readout (see ui/PerfPanel.tsx): how long frames take, where the main
 * thread's time goes, and how much is drawn.
 *
 * GPU time isn't measured directly (browsers mostly hide GPU timer
 * queries); a GPU-bound view shows up as long frames with little CPU time.
 */

export interface PerfSample {
  /** Time since the previous frame, ms — what the viewer actually sees. */
  interval: number;
  /** Simulating people and traffic, ms. */
  sim: number;
  /** Issuing the frame's drawing (all passes, shadows included), ms of CPU. */
  render: number;
  calls: number;
  triangles: number;
}

export interface PerfSummary {
  frames: number;
  fps: number;
  frameMs: number;
  frameP95Ms: number;
  simMs: number;
  renderMs: number;
  calls: number;
  triangles: number;
}

const MAX_SAMPLES = 2000;

export class PerfRecorder {
  private samples: PerfSample[] = [];

  push(sample: PerfSample): void {
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** Summary of the frames since the last reset. */
  summarize(reset: boolean): PerfSummary {
    const samples = this.samples;
    if (reset) this.samples = [];
    const n = samples.length;
    if (n === 0) return { frames: 0, fps: 0, frameMs: 0, frameP95Ms: 0, simMs: 0, renderMs: 0, calls: 0, triangles: 0 };
    const mean = (key: keyof PerfSample) => samples.reduce((sum, s) => sum + s[key], 0) / n;
    const intervals = samples.map((s) => s.interval).sort((a, b) => a - b);
    const frameMs = mean("interval");
    return {
      frames: n,
      fps: frameMs > 0 ? 1000 / frameMs : 0,
      frameMs,
      frameP95Ms: intervals[Math.min(n - 1, Math.floor(n * 0.95))],
      simMs: mean("sim"),
      renderMs: mean("render"),
      calls: mean("calls"),
      triangles: mean("triangles"),
    };
  }
}
