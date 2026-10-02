/** Small deterministic string hash, so a given element always gets the same
 * variant across reloads and across the map/3D views.
 *
 * Split out of `materials.ts` (where this used to live) into its own file:
 * `materials.ts`'s import chain pulls in texture loaders and `sun.ts` (which
 * imports `suncalc`), none of which run at import time but which ES modules
 * still evaluate file-by-file — `workers/treeWorker.ts` only needs this one
 * pure function and shouldn't drag that whole graph into a worker bundle.
 */
export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic yaw (radians) for furniture OSM gives no orientation to
 * (benches, kiosks, playgrounds...) — a plaza of identically aligned benches
 * looks like a rendering artefact. Shared so anything placed relative to a
 * piece of furniture (people sitting on a bench) agrees with how it's drawn. */
export function elementYaw(elementId: string): number {
  return ((hashString(elementId) % 360) * Math.PI) / 180;
}
