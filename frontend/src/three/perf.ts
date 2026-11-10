/** Per-frame performance figures for the 3D view, for the `?perf=1`
 * readout (see ui/PerfPanel.tsx): how long frames take, where the main
 * thread's time goes, and how much is drawn.
 *
 * GPU time isn't measured directly (browsers mostly hide GPU timer
 * queries); a GPU-bound view shows up as long frames with little CPU time.
 */

import * as THREE from "three";

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

/** One row of the scene's breakdown: what a named part of it draws. */
export interface BreakdownRow {
  part: string;
  /** Meshes drawn, each at least one draw call per pass. */
  meshes: number;
  /** Copies drawn by those meshes (instancing: one call, many copies). */
  copies: number;
  /** Triangles in one pass over the part (all its copies). */
  triangles: number;
  /** Of those, the ones casting shadows: drawn again for each shadow map
   * (the sun's, and each streetlight casting real shadows at night). */
  shadowTriangles: number;
}

function partName(object: THREE.Object3D, root: THREE.Object3D): string {
  // The outermost named ancestor below the root, going one level deeper
  // through the scene's own group ("civic-scene"), whose children are the
  // parts (SceneBuilder.ts names them).
  const chain: THREE.Object3D[] = [];
  for (let o: THREE.Object3D | null = object; o && o !== root; o = o.parent) chain.unshift(o);
  const top = chain[0];
  const part = top?.name === "civic-scene" ? chain[1] : top;
  return part?.name || part?.type || "?";
}

function trianglesOf(mesh: THREE.Mesh): number {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const vertices = geometry.index ? geometry.index.count : (geometry.attributes.position?.count ?? 0);
  return Math.floor(Math.min(vertices, geometry.drawRange.count) / 3);
}

/** What the scene holds, by part: the visible meshes, their copies and
 * triangles (before the camera's culling: everything in the scene). For
 * the readout's breakdown, computed when asked. */
export function sceneBreakdown(root: THREE.Object3D): BreakdownRow[] {
  const rows = new Map<string, BreakdownRow>();
  root.traverseVisible((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const instanced = object as THREE.InstancedMesh;
    const copies = instanced.isInstancedMesh ? instanced.count : 1;
    if (copies === 0) return;
    const triangles = trianglesOf(mesh) * copies;
    const part = partName(object, root);
    const row = rows.get(part) ?? { part, meshes: 0, copies: 0, triangles: 0, shadowTriangles: 0 };
    row.meshes += 1;
    row.copies += copies;
    row.triangles += triangles;
    if (mesh.castShadow) row.shadowTriangles += triangles;
    rows.set(part, row);
  });
  return [...rows.values()].sort((a, b) => b.triangles - a.triangles);
}

/** Shadow-map passes when all the shadows are redrawn: one per sun or spot
 * light casting shadows, six per point light (a cube). Each draws the
 * parts' `shadowTriangles` again. */
export function shadowPasses(root: THREE.Object3D): number {
  let passes = 0;
  root.traverseVisible((object) => {
    const light = object as THREE.Light;
    if (!light.isLight || !light.castShadow) return;
    passes += (object as THREE.PointLight).isPointLight ? 6 : 1;
  });
  return passes;
}
