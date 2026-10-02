/** Worker entry point for tree geometry generation — see
 * `treeWorkerPool.ts` for why this exists (per-tree structure/bark/foliage
 * math is pure, CPU-bound, and fully independent across trees, so it moves
 * off the main thread almost for free).
 *
 * Runs the exact same build sequence `vegetation.ts` used to run inline for
 * each tree — `buildTreeStructure` -> `buildBarkGeometry` -> translate ->
 * `buildLeafGeometry`/`buildNeedleGeometry` -> translate — then reads the
 * resulting `BufferGeometry`s' attribute arrays (already typed arrays; no
 * conversion needed) into a `TreeBuildResult` and posts them back with every
 * included `ArrayBuffer` in the transfer list, so the main thread receives
 * them without a copy.
 */

/// <reference lib="webworker" />
// The project's tsconfig uses the "DOM" lib (for the main-thread code that's
// the vast majority of this codebase), which declares a conflicting `self`
// global and can't be combined with "WebWorker" project-wide. The reference
// above pulls in just the *type* declarations (DedicatedWorkerGlobalScope)
// without changing the global lib; the local `declare const self` below
// shadows the ambient DOM-typed `self` within this module's own scope only.
declare const self: DedicatedWorkerGlobalScope;

import { buildBarkGeometry } from "../builders/branches";
import { buildLeafGeometry, SUMMER_PALETTE } from "../builders/foliageCards";
import { buildTreeStructure } from "../builders/treeStructure";
import { hashString } from "../hash";
import { buildNeedleGeometry } from "../builders/needles";
import type { FoliageAttributes, TreeBuildResult, TreeJob, TreeWorkerRequest, TreeWorkerResponse } from "./treeJobs";

/** Same cutoff `vegetation.ts`'s `BARK_RENDER_MAX_LEVEL` uses — see that
 * constant's docstring for why it's set to `treeStructure.ts`'s own
 * `MAX_LEVEL` (6), i.e. deliberately never the limiting factor. Duplicated
 * here rather than imported because it's a `vegetation.ts`-owned rendering
 * constant, not something `treeStructure.ts`/`branches.ts` export. */
const BARK_RENDER_MAX_LEVEL = 6;

function buildOne(job: TreeJob): TreeBuildResult {
  const structure = buildTreeStructure(hashString(job.id), job.trunkTop, job.height, job.canopyDiameter, job.crownForm);

  const barkGeometry = buildBarkGeometry(structure, BARK_RENDER_MAX_LEVEL);
  barkGeometry.translate(job.x, 0, job.z);
  const bark = {
    position: barkGeometry.attributes.position.array as Float32Array,
    normal: barkGeometry.attributes.normal.array as Float32Array,
    index: barkGeometry.index!.array as Uint16Array | Uint32Array,
  };

  let foliage: FoliageAttributes | null = null;
  if (job.density > 0) {
    if (job.isEvergreen) {
      const needleGeometry = buildNeedleGeometry(structure, hashString(`${job.id}:needles`), job.density);
      if (needleGeometry) {
        needleGeometry.translate(job.x, 0, job.z);
        foliage = {
          kind: "needle",
          position: needleGeometry.attributes.position.array as Float32Array,
          normal: needleGeometry.attributes.normal.array as Float32Array,
          color: needleGeometry.attributes.color.array as Float32Array,
        };
      }
    } else {
      const leafGeometry = buildLeafGeometry(
        structure,
        hashString(`${job.id}:leaves`),
        job.canopyDiameter,
        job.density,
        SUMMER_PALETTE,
        job.autumnMix
      );
      if (leafGeometry) {
        leafGeometry.translate(job.x, 0, job.z);
        foliage = {
          kind: "leaf",
          position: leafGeometry.attributes.position.array as Float32Array,
          normal: leafGeometry.attributes.normal.array as Float32Array,
          uv: leafGeometry.attributes.uv.array as Float32Array,
          color: leafGeometry.attributes.color.array as Float32Array,
          index: leafGeometry.index!.array as Uint16Array | Uint32Array,
        };
      }
    }
  }

  return { id: job.id, bark, foliage };
}

/** Every ArrayBuffer backing a result's typed arrays, for the transfer
 * list — this is what makes the postMessage below zero-copy. `.buffer` is
 * typed as `ArrayBufferLike` (it also covers `SharedArrayBuffer`, which
 * isn't transferable) but every array here was created fresh from a plain
 * JS array by this module's own builder calls, so it's always a real
 * `ArrayBuffer`. */
function collectTransferables(results: TreeBuildResult[]): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const result of results) {
    buffers.push(
      result.bark.position.buffer as ArrayBuffer,
      result.bark.normal.buffer as ArrayBuffer,
      result.bark.index.buffer as ArrayBuffer
    );
    if (result.foliage) {
      buffers.push(
        result.foliage.position.buffer as ArrayBuffer,
        result.foliage.normal.buffer as ArrayBuffer,
        result.foliage.color.buffer as ArrayBuffer
      );
      if (result.foliage.kind === "leaf") {
        buffers.push(result.foliage.uv.buffer as ArrayBuffer, result.foliage.index.buffer as ArrayBuffer);
      }
    }
  }
  return buffers;
}

self.onmessage = (event: MessageEvent<TreeWorkerRequest>) => {
  const { generation, jobs } = event.data;
  const results = jobs.map(buildOne);
  const response: TreeWorkerResponse = { generation, results };
  self.postMessage(response, { transfer: collectTransferables(results) });
};
