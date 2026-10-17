/** How long the app takes to catch up with a change — a new date, year or
 * card — until the view is consistent again: trees, field and crowd for the
 * same moment. For the `?perf=1` readout (ui/PerfPanel.tsx).
 *
 * A change opens an interaction (`markInput`). The slow steps it sets off
 * register as pending tasks (`begin`/`end`: a scene from the backend, a
 * felt-temperature field, a 3D build, the daily curve); the interaction is
 * settled once none is pending and a frame has been drawn since. A new
 * change while one is open replaces it: what counts is how long after the
 * *last* change the view is right.
 *
 * Always on, and cheap: a few timestamps per change, and a frame loop only
 * while an interaction is open.
 */

export interface Stage {
  task: string;
  /** ms since the interaction started. */
  start: number;
  end: number;
}

export interface Interaction {
  label: string;
  /** performance.now() at the change. */
  at: number;
  /** ms from the change to a consistent view; null while still open. */
  settledMs: number | null;
  /** Each pending task's spans during the interaction. */
  stages: Stage[];
  /** Longest gap between two frames while it was open: the main thread
   * blocked, as the viewer sees it. */
  longestFrameMs: number;
}

// Frames to wait with nothing pending before calling it settled: the first
// lets React apply what the last task brought, the second draws it.
const SETTLE_FRAMES = 2;
// A second mark before any frame was drawn, or this soon after the first,
// is the same change seen twice (the benchmark marks it, then the app's own
// handler does).
const SAME_CHANGE_MS = 50;
const MAX_HISTORY = 50;

const pending = new Map<string, { count: number; since: number }>();
let open: Interaction | null = null;
let idleFrames = 0;
let framesSinceOpen = 0;
let lastFrameAt = 0;
let looping = false;
const history: Interaction[] = [];
const listeners = new Set<(interaction: Interaction) => void>();

function now(): number {
  return performance.now();
}

function startLoop(): void {
  if (looping) return;
  looping = true;
  lastFrameAt = now();
  requestAnimationFrame(tick);
}

function tick(): void {
  const at = now();
  const interaction = open;
  if (!interaction) {
    looping = false;
    return;
  }
  interaction.longestFrameMs = Math.max(interaction.longestFrameMs, at - lastFrameAt);
  lastFrameAt = at;
  framesSinceOpen++;
  idleFrames = pending.size === 0 ? idleFrames + 1 : 0;
  if (idleFrames >= SETTLE_FRAMES) {
    interaction.settledMs = at - interaction.at;
    open = null;
    history.push(interaction);
    if (history.length > MAX_HISTORY) history.shift();
    for (const listener of listeners) listener(interaction);
    looping = false;
    return;
  }
  requestAnimationFrame(tick);
}

/** A change the view has to catch up with — now, or at `at` (a
 * performance.now() time: 0 for the page load). */
export function markInput(label: string, at = now()): void {
  if (open && at >= open.at && (framesSinceOpen === 0 || at - open.at < SAME_CHANGE_MS)) return;
  open = { label, at, settledMs: null, stages: [], longestFrameMs: 0 };
  // Tasks already under way (a request issued just before) count from now.
  for (const task of pending.values()) task.since = Math.max(task.since, at);
  idleFrames = 0;
  framesSinceOpen = 0;
  startLoop();
}

/** A slow step starts (several of the same kind may overlap). */
export function begin(task: string): void {
  const entry = pending.get(task);
  if (entry) entry.count++;
  else pending.set(task, { count: 1, since: now() });
  idleFrames = 0;
}

/** …and ends. */
export function end(task: string): void {
  const entry = pending.get(task);
  if (!entry) return;
  if (--entry.count > 0) return;
  pending.delete(task);
  if (open) open.stages.push({ task, start: Math.max(0, entry.since - open.at), end: now() - open.at });
  idleFrames = 0;
}

export function isPending(task: string): boolean {
  return pending.has(task);
}

export function isOpen(): boolean {
  return open !== null;
}

/** The interactions settled so far, oldest first. */
export function settledInteractions(): readonly Interaction[] {
  return history;
}

export function onSettled(listener: (interaction: Interaction) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Resolves with the open interaction once settled — or null after
 * `timeoutMs` (something stuck pending), or straight away with nothing
 * open. */
export function waitForSettled(timeoutMs: number): Promise<Interaction | null> {
  if (!open) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve(null);
    }, timeoutMs);
    const stop = onSettled((interaction) => {
      clearTimeout(timer);
      stop();
      resolve(interaction);
    });
  });
}

/** Per task, how long it kept the interaction waiting: from its first start
 * to its last end (tasks of one kind may come in several spans). */
export function stageSpans(interaction: Interaction): Record<string, number> {
  const spans: Record<string, { start: number; end: number }> = {};
  for (const stage of interaction.stages) {
    const span = spans[stage.task];
    spans[stage.task] = span
      ? { start: Math.min(span.start, stage.start), end: Math.max(span.end, stage.end) }
      : { start: stage.start, end: stage.end };
  }
  return Object.fromEntries(Object.entries(spans).map(([task, span]) => [task, span.end - span.start]));
}

const TASK_LABELS: Record<string, string> = {
  scene: "scene",
  field: "field",
  build: "3D build",
  curve: "curve",
};

/** A task's name for the readout. */
export function taskLabel(task: string): string {
  return TASK_LABELS[task] ?? task;
}

/** What's pending right now, for a stuck interaction's report. */
export function pendingTasks(): string[] {
  return [...pending.keys()];
}
