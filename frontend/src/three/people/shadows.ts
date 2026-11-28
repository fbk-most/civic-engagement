import type * as THREE from "three";

/** Lets a moving mesh (a person, a dog, a car) cast the sun's shadow but
 * not a streetlight's. The sun's shadow is drawn again every frame; a
 * streetlight's only when the light moves to another lamp (see the urban
 * pack's streetlights.ts, `shadow.autoUpdate = false`, which keeps nights
 * fast): drawn into it, a figure would leave its shadow where it stood
 * while it walked on. A streetlight's shadow camera is a perspective one
 * (a point light's, six faces), the sun's an orthographic one: nothing is
 * drawn for the first. */
export function sunShadowOnly(mesh: THREE.Mesh): void {
  let count = Infinity;
  mesh.onBeforeShadow = (_renderer, _object, _camera, shadowCamera, geometry) => {
    if (!(shadowCamera as THREE.PerspectiveCamera).isPerspectiveCamera) return;
    count = geometry.drawRange.count;
    geometry.drawRange.count = 0;
  };
  mesh.onAfterShadow = (_renderer, _object, _camera, shadowCamera, geometry) => {
    if ((shadowCamera as THREE.PerspectiveCamera).isPerspectiveCamera) geometry.drawRange.count = count;
  };
}

/** `sunShadowOnly` for every mesh under `root` (a figure, cloned). */
export function sunShadowsOnly(root: THREE.Object3D): void {
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) sunShadowOnly(object as THREE.Mesh);
  });
}
