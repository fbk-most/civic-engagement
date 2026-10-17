/** The responsiveness benchmark of the `?perf=1` readout: the same changes,
 * in the same order, on any machine — dates, a year, dragging the hour,
 * many dates in a row — each timed until the view is consistent again
 * (perf/timeline.ts), against the agreed targets.
 *
 * Cards aren't part of it: adding one writes to the workshop's session.
 * Their latency shows in the live readout ("Ultimo aggiornamento") when
 * added by hand.
 */

import type { SunSetting } from "../three/sun";
import * as timeline from "./timeline";

export interface Controls {
  setSun: (setting: SunSetting) => void;
  setYear: (t: number) => void;
  year: number;
}

export interface ResultRow {
  label: string;
  /** What's measured, and the target. */
  kpi: string;
  value: string;
  pass: boolean | null;
  /** Where the time went, and the longest frame meanwhile. */
  detail: string;
}

// Agreed targets (2026-10-14).
const CACHED_MS = 1000;
const UNCACHED_MS = 2000;
const YEAR_MS = 2000;
const DRAG_MIN_FPS = 20;
const DRAG_MAX_FRAME_MS = 100;
const HEAP_MAX_MB = 2048;

const SETTLE_TIMEOUT_MS = 20000;
// After each step, time for the background fetches it sets off (the
// neighbouring months, the preset days), so the next step finds the cache
// as a user pausing between clicks would.
const PAUSE_MS = 2500;
const DATES_IN_A_ROW = 20;
const BASE: SunSetting = { month: 6, day: 21, hour: 15 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function heapMb(): number | null {
  // Chrome only (and non-standard); elsewhere the memory row says so.
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize / 2 ** 20 : null;
}

function breakdown(interaction: timeline.Interaction): string {
  const spans = Object.entries(timeline.stageSpans(interaction))
    .map(([task, ms]) => `${timeline.taskLabel(task)} ${Math.round(ms)}`)
    .join(", ");
  return `${spans || "no waiting"}; longest frame ${Math.round(interaction.longestFrameMs)} ms`;
}

/** Applies a change and times it until the view is consistent. */
async function timed(label: string, kpi: string, targetMs: number, change: () => void): Promise<ResultRow> {
  timeline.markInput(label);
  change();
  const interaction = await timeline.waitForSettled(SETTLE_TIMEOUT_MS);
  await sleep(PAUSE_MS);
  if (!interaction) {
    return {
      label,
      kpi,
      value: `> ${SETTLE_TIMEOUT_MS / 1000} s`,
      pass: false,
      detail: `waiting for: ${timeline.pendingTasks().join(", ") || "?"}`,
    };
  }
  const ms = interaction.settledMs ?? 0;
  return { label, kpi, value: `${Math.round(ms)} ms`, pass: ms <= targetMs, detail: breakdown(interaction) };
}

/** Drags the hour across the afternoon, one step a frame, as a hand would. */
async function dragHour(controls: Controls): Promise<ResultRow> {
  const intervals: number[] = [];
  let last = performance.now();
  for (let hour = 9; hour <= 18; hour += 0.05) {
    controls.setSun({ ...BASE, hour });
    await nextFrame();
    const at = performance.now();
    intervals.push(at - last);
    last = at;
  }
  await timeline.waitForSettled(SETTLE_TIMEOUT_MS);
  await sleep(PAUSE_MS);
  const mean = intervals.reduce((sum, ms) => sum + ms, 0) / intervals.length;
  const fps = 1000 / mean;
  const worst = Math.max(...intervals);
  return {
    label: "Dragging the hour (9→18)",
    kpi: `≥ ${DRAG_MIN_FPS} fps, frame ≤ ${DRAG_MAX_FRAME_MS} ms`,
    value: `${fps.toFixed(0)} fps`,
    pass: fps >= DRAG_MIN_FPS && worst <= DRAG_MAX_FRAME_MS,
    detail: `longest frame ${Math.round(worst)} ms, ${intervals.length} steps`,
  };
}

export async function runResponsiveness(
  controls: Controls,
  onRow: (row: ResultRow) => void,
  cancelled: () => boolean,
  onStep: (label: string) => void
): Promise<void> {
  const start = controls.year;
  const step = async (label: string, run: () => Promise<ResultRow>) => {
    if (cancelled()) return;
    onStep(label);
    onRow(await run());
  };

  // Starting point, not timed: the base day, settled, its neighbours fetched.
  onStep("Setup");
  timeline.markInput("setup");
  controls.setSun(BASE);
  await timeline.waitForSettled(SETTLE_TIMEOUT_MS);
  await sleep(PAUSE_MS * 2);
  const heapBefore = heapMb();

  const cached = `consistently ≤ ${CACHED_MS} ms`;
  const uncached = `consistently ≤ ${UNCACHED_MS} ms`;
  await step("Month after", () =>
    timed("Month after (21/7, preloaded)", cached, CACHED_MS, () => controls.setSun({ ...BASE, month: 7 }))
  );
  await step("New day", () =>
    timed("Day not preloaded (10/9)", uncached, UNCACHED_MS, () =>
      controls.setSun({ ...BASE, month: 9, day: 10 })
    )
  );
  await step("Winter solstice", () =>
    timed("Winter solstice (preloaded)", cached, CACHED_MS, () => controls.setSun({ ...BASE, month: 12 }))
  );
  await step("Return", () =>
    timed("Return to a date already seen (21/6)", cached, CACHED_MS, () => controls.setSun(BASE))
  );
  const later = Math.min(30, start + 10);
  await step("Year", () =>
    timed(`Year +${later - start}`, `consistently ≤ ${YEAR_MS} ms`, YEAR_MS, () => controls.setYear(later))
  );
  await step("Year back", () =>
    timed("Back to the starting year", `consistently ≤ ${YEAR_MS} ms`, YEAR_MS, () => controls.setYear(start))
  );
  await step("Hour", () => dragHour(controls));

  // Memory: many dates in a row, each settled, as a long workshop would.
  if (cancelled()) return;
  onStep(`${DATES_IN_A_ROW} dates in a row`);
  const settles: number[] = [];
  for (let i = 0; i < DATES_IN_A_ROW && !cancelled(); i++) {
    timeline.markInput("date");
    controls.setSun({ month: (i % 12) + 1, day: 1 + ((i * 7) % 28), hour: 15 });
    const interaction = await timeline.waitForSettled(SETTLE_TIMEOUT_MS);
    if (interaction?.settledMs) settles.push(interaction.settledMs);
  }
  timeline.markInput("date");
  controls.setSun(BASE);
  await timeline.waitForSettled(SETTLE_TIMEOUT_MS);
  await sleep(PAUSE_MS);
  const heapAfter = heapMb();
  const median = settles.sort((a, b) => a - b)[Math.floor(settles.length / 2)] ?? 0;
  onRow({
    label: `Memory after ${DATES_IN_A_ROW} dates`,
    kpi: `heap JS ≤ ${HEAP_MAX_MB} MB`,
    value: heapAfter === null ? "n/a" : `${Math.round(heapAfter)} MB`,
    pass: heapAfter === null ? null : heapAfter <= HEAP_MAX_MB,
    detail:
      (heapBefore === null ? "heap not measurable in this browser" : `before ${Math.round(heapBefore)} MB`) +
      `; median time per date ${Math.round(median)} ms`,
  });
}
