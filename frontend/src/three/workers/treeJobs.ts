/** Message shapes shared between `vegetation.ts` (main thread) and
 * `treeWorker.ts` (worker) — plain data only, no runtime code, so importing
 * this from either side never pulls in anything worker-unsafe.
 *
 * Every `TreeJob` field is a value `vegetation.ts`'s tree loop already
 * computes today (see its per-tree locals); this just carries them across
 * the postMessage boundary instead of feeding them straight into
 * `buildTreeStructure`/`buildBarkGeometry`/`buildLeafGeometry`/
 * `buildNeedleGeometry` inline.
 */

import type { CrownForm } from "../builders/treeStructure";

export interface TreeJob {
  id: string;
  x: number;
  z: number;
  trunkTop: number;
  height: number;
  canopyDiameter: number;
  crownForm: CrownForm;
  isEvergreen: boolean;
  density: number;
  autumnMix: number;
}

/** Typed-array attribute set for one merge-ready geometry, already
 * world-translated by the worker (see `treeWorker.ts`) — `vegetation.ts`
 * wraps each array directly in a `THREE.BufferAttribute` (not
 * `Float32BufferAttribute`, which would copy) to keep the zero-copy
 * transfer meaningful. */
export interface BarkAttributes {
  position: Float32Array;
  normal: Float32Array;
  index: Uint16Array | Uint32Array;
}

export type FoliageAttributes =
  | {
      kind: "leaf";
      position: Float32Array;
      normal: Float32Array;
      uv: Float32Array;
      color: Float32Array;
      index: Uint16Array | Uint32Array;
    }
  | {
      kind: "needle";
      position: Float32Array;
      normal: Float32Array;
      color: Float32Array;
    };

export interface TreeBuildResult {
  id: string;
  bark: BarkAttributes;
  foliage: FoliageAttributes | null;
}

/** One worker's unit of work: a subset of the jobs from the current
 * `buildTreesInWorkers` call, tagged with the pool's generation so a
 * response from a superseded build can be recognised and dropped (see
 * `treeWorkerPool.ts`). */
export interface TreeWorkerRequest {
  generation: number;
  jobs: TreeJob[];
}

export interface TreeWorkerResponse {
  generation: number;
  results: TreeBuildResult[];
}
