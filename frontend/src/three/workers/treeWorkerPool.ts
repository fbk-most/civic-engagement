/** Pool of persistent module workers that build tree geometry off the main
 * thread — see `treeWorker.ts` for what actually runs in each one, and
 * `treeJobs.ts` for the message shapes.
 *
 * Workers are lazily created on first use and kept alive across calls —
 * spawning a worker isn't free, and recreating the whole pool on every
 * scene rebuild would eat into the win. The one time they *are* torn down
 * and respawned is if a new build starts while a previous one is still
 * running: vegetation rebuilds fire on every scenario-year change, so rapid
 * slider scrubbing is a real interaction pattern here, not a hypothetical —
 * without hard cancellation, a stale in-flight build (whose result is about
 * to be discarded by `Viewer.tsx`'s own staleness check) would keep
 * competing for the same cores as the one build that actually matters.
 *
 * On top of that, results are memoized by job content (see `treeJobKey`):
 * a tree's geometry depends on nothing but its own `TreeJob` fields — not
 * on the season, which is applied when drawing (see `vegetation.ts`) — so
 * an unchanged tree (a card added elsewhere, a year when it didn't grow)
 * needs no worker round trip at all, just a map lookup. The
 * key is derived from every field that affects the result, so the cache is
 * self-invalidating: there's no separate invalidation path to get wrong,
 * a changed input is just a different key.
 */

import type { TreeBuildResult, TreeJob, TreeWorkerRequest, TreeWorkerResponse } from "./treeJobs";

const POOL_SIZE = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));

/** Bounded by size, not by count: one scenario year's trees for Piazza
 * Dante are about 500 MB of typed arrays (full canopy, measured as 460 MB
 * before the season attributes), and the scene shown holds a merged copy
 * of them on top. A count bound (6000 entries, as before) let a session
 * visiting a few dates and years grow the tab past its memory and crash it.
 * This keeps a year's worth and some — returning to the year shown before
 * reuses whatever trees didn't change — and drops the least recently used
 * beyond that. (Dates no longer matter: the season is applied when
 * drawing.) */
const MAX_CACHE_BYTES = 700_000_000;
let cacheBytes = 0;

function resultBytes(result: TreeBuildResult): number {
  let bytes = 0;
  for (const part of [result.bark, result.foliage]) {
    if (!part) continue;
    for (const value of Object.values(part)) {
      if (ArrayBuffer.isView(value)) bytes += value.byteLength;
    }
  }
  return bytes;
}

/** Insertion order doubles as recency order here: a hit is re-inserted (see
 * `cacheGet`) to bump it to the end, so the oldest entry — the one evicted
 * when the cache is full (see `cacheSet`) — is genuinely least-recently-used,
 * not just least-recently-added. */
const resultCache = new Map<string, TreeBuildResult>();

/** Every `TreeJob` field that affects the built geometry — position
 * included, even though a given tree's `(x, z)` never actually changes
 * within a session, since including it costs nothing and makes the cache
 * correct without relying on that assumption. */
export function treeJobKey(job: TreeJob): string {
  return [
    job.id,
    job.x,
    job.y,
    job.z,
    job.trunkTop,
    job.height,
    job.canopyDiameter,
    job.crownForm,
    job.isEvergreen,
  ].join(":");
}

function cacheGet(key: string): TreeBuildResult | undefined {
  const hit = resultCache.get(key);
  if (hit) {
    resultCache.delete(key);
    resultCache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, result: TreeBuildResult): void {
  const previous = resultCache.get(key);
  if (previous) cacheBytes -= resultBytes(previous);
  resultCache.set(key, result);
  cacheBytes += resultBytes(result);
  while (cacheBytes > MAX_CACHE_BYTES && resultCache.size > 1) {
    const [oldestKey, oldest] = resultCache.entries().next().value!;
    resultCache.delete(oldestKey);
    cacheBytes -= resultBytes(oldest);
  }
}

let workers: Worker[] | null = null;
let generationCounter = 0;

/** Set while a build is in flight, so a new call can detect (and hard-cancel)
 * a superseded one before it finishes. */
let pending: { generation: number; resolve: (results: TreeBuildResult[]) => void; reject: (error: unknown) => void } | null = null;

function spawnWorkers(): Worker[] {
  const pool: Worker[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    pool.push(new Worker(new URL("./treeWorker.ts", import.meta.url), { type: "module" }));
  }
  return pool;
}

function ensureWorkers(): Worker[] {
  if (!workers) workers = spawnWorkers();
  return workers;
}

/** Builds every tree's geometry, serving whatever's already cached (see
 * module docstring) straight from memory and sending only genuine misses
 * across the worker pool. Result order does not match `jobs` order —
 * nothing downstream cares (`vegetation.ts` merges every tree's geometry
 * into shared meshes regardless of arrival order) — so results are simply
 * concatenated as each worker's response arrives. */
export function buildTreesInWorkers(jobs: TreeJob[]): Promise<TreeBuildResult[]> {
  const generation = ++generationCounter;

  if (pending) {
    // A previous build is still in flight — hard-cancel it (terminate +
    // respawn) so the pool is fully available for this one, rather than
    // splitting cores between a result that's about to be discarded and the
    // one that actually matters. The stale call's promise resolves quietly
    // (not rejects) with an empty result: its caller already has its own
    // staleness flag (see Viewer.tsx's scene-rebuild effect) and discards
    // whatever it gets, so there's nothing to treat as an error here.
    for (const worker of ensureWorkers()) worker.terminate();
    workers = null;
    pending.resolve([]);
    pending = null;
  }

  const results: TreeBuildResult[] = [];
  const missKeysById = new Map<string, string>();
  const misses: TreeJob[] = [];
  for (const job of jobs) {
    const key = treeJobKey(job);
    const cached = cacheGet(key);
    if (cached) {
      results.push(cached);
    } else {
      missKeysById.set(job.id, key);
      misses.push(job);
    }
  }

  if (misses.length === 0) return Promise.resolve(results);

  return new Promise((resolve, reject) => {
    pending = { generation, resolve, reject };

    const pool = ensureWorkers();
    const chunks: TreeJob[][] = Array.from({ length: pool.length }, () => []);
    misses.forEach((job, i) => chunks[i % pool.length].push(job));

    let outstanding = 0;

    const settle = (fn: () => void) => {
      // Guards against a terminated worker's listener still firing after
      // this generation has already been superseded and replaced.
      if (pending?.generation !== generation) return;
      fn();
    };

    for (let i = 0; i < pool.length; i++) {
      const chunk = chunks[i];
      if (chunk.length === 0) continue;
      outstanding++;

      const worker = pool[i];
      const onMessage = (event: MessageEvent<TreeWorkerResponse>) => {
        if (event.data.generation !== generation) return; // stale response from a since-superseded build
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        for (const result of event.data.results) {
          const key = missKeysById.get(result.id);
          if (key) cacheSet(key, result);
          results.push(result);
        }
        outstanding--;
        if (outstanding === 0) {
          settle(() => {
            pending = null;
            resolve(results);
          });
        }
      };
      const onError = (event: ErrorEvent) => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        settle(() => {
          pending = null;
          reject(event.error ?? new Error(event.message));
        });
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);

      const request: TreeWorkerRequest = { generation, jobs: chunk };
      worker.postMessage(request);
    }
  });
}

/** Terminates every pool worker — called from `Viewer.tsx`'s unmount
 * cleanup, alongside its other renderer/material disposal, so closing the
 * 3D panel doesn't leave workers running in the background. */
export function terminateTreeWorkerPool(): void {
  if (!workers) return;
  for (const worker of workers) worker.terminate();
  workers = null;
  pending = null;
}
