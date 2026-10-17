import * as THREE from "three";

/** Fills an InstancedMesh from a list of per-instance transforms. */
export function instanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  transforms: THREE.Matrix4[],
  name: string
): THREE.InstancedMesh | null {
  if (transforms.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
  transforms.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = name;
  // Instanced bounds are computed from the source geometry alone, which sits
  // at the origin — without this every instance frustum-culls as one blob.
  mesh.frustumCulled = false;
  return mesh;
}
