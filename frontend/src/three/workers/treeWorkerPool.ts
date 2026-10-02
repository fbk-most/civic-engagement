/** Pool of persistent module workers that build tree geometry off the main
 * thread — see `treeWorker.ts` for what actually runs in each one, and
 * `treeJobs.ts` for the message shapes.
 *
 * Workers are lazily created on first use and kept alive across calls —
 * spawning a worker isn't free, and recreating the whole pool on every
 * scene rebuild would eat into the win. The one time they *are* torn down
 * and respawned is if a new build starts while a previous one is still
 * running: `SceneBuilder.ts`'s own docstring notes vegetation rebuilds fire
 * on every scenario-year *and* every month/date change, so rapid slider
 * scrubbing is a real interaction pattern here, not a hypothetical —
 * without hard cancellation, a stale in-flight build (whose result is about
 * to be discarded by `Viewer.tsx`'s own staleness check) would keep
 * competing for the same cores as the one build that actually matters.
 *
 * On top of that, results are memoized by job content (see `jobCacheKey`):
 * a tree's geometry depends on nothing but its own `TreeJob` fields, so an
 * exact repeat — an evergreen tree, whose `density`/`autumnMix` never vary
 * with season at all; or revisiting a month/year combination already seen
 * this session — needs no worker round trip at all, just a map lookup. The
 * key is derived from every field that affects the result, so the cache is
 * self-invalidating: there's no separate invalidation path to get wrong,
 * a changed input is just a different key.
 */

import type { TreeBuildResult, TreeJob, TreeWorkerRequest, TreeWorkerResponse } from "./treeJobs";

const POOL_SIZE = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));

/** Generous enough to hold several full scenes' worth of distinct tree
 * states (a session revisiting a handful of months across a handful of
 * scenario years) without the cache defeating its own purpose, bounded so
 * an very long-running session doesn't grow this without limit — each entry
 * is a tree's worth of typed arrays, not a trivial amount of memory times
 * hundreds of trees times many visited states. */
const MAX_CACHE_ENTRIES = 6000;

/** Insertion order doubles as recency order here: a hit is re-inserted (see
 * `cacheGet`) to bump it to the end, so the oldest entry — the one evicted
 * when the cache is full (see `cacheSet`) — is genuinely least-recently-used,
 * not just least-recently-added. */
const resultCache = new Map<string, TreeBuildResult>();

/** Every `TreeJob` field that affects the built geometry — position
 * included, even though a given tree's `(x, z)` never actually changes
 * within a session, since including it costs nothing and makes the cache
 * correct without relying on that assumption. */
function jobCacheKey(job: TreeJob): string {
  return [
    job.id,
    job.x,
    job.z,
    job.trunkTop,
    job.height,
    job.canopyDiameter,
    job.crownForm,
    job.isEvergreen,
    job.density,
    job.autumnMix,
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
  resultCache.set(key, result);
  if (resultCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = resultCache.keys().next().value;
    if (oldestKey !== undefined) resultCache.delete(oldestKey);
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
    const key = jobCacheKey(job);
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
