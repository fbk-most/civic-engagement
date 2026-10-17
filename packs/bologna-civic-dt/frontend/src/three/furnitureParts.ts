import * as THREE from "three";
import { elementYaw, instanced, toLocal, type PartBuilder } from "civic-engagement";
import {
  buildBenchGeometry,
  buildFitnessGeometry,
  buildFountainGeometry,
  buildKioskGeometry,
  buildPergolaGeometry,
  buildPlaygroundGeometry,
  buildTrafficSignalGeometry,
} from "./furniture";
import {
  fitnessEquipment,
  furniture,
  kioskBody,
  pergolaTimber,
  playgroundEquipment,
  trafficSignalMetal,
  waterFeature,
} from "./materials";

/** Street furniture, one instanced mesh per kind. Streetlights are a part
 * of their own (streetlights.ts): each needs an individual light, not just
 * instanced geometry. */
export const buildFurniture: PartBuilder = ({ elements, anchor, materials, terrain }) => {
  const group = new THREE.Group();
  group.name = "furniture";

  const benches: THREE.Matrix4[] = [];
  const fountains: THREE.Matrix4[] = [];
  const kiosks: THREE.Matrix4[] = [];
  const playgrounds: THREE.Matrix4[] = [];
  const fitnessAreas: THREE.Matrix4[] = [];
  const trafficSignals: THREE.Matrix4[] = [];
  // Pergola geometry depends on the card's `size` param, so instances are
  // batched by size.
  const pergolasBySize = new Map<string, THREE.Matrix4[]>();

  for (const element of elements) {
    if (element.geometry.type !== "Point") continue;
    const [lng, lat] = element.geometry.coordinates;
    const [x, z] = toLocal(anchor, lng, lat);
    const y = terrain.heightAt(x, z);

    if (element.type === "bench") {
      const yaw = elementYaw(element.id);
      benches.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z));
    } else if (element.type === "water_feature") {
      fountains.push(new THREE.Matrix4().setPosition(x, y, z));
    } else if (element.type === "kiosk") {
      const yaw = elementYaw(element.id);
      kiosks.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z));
    } else if (element.type === "playground") {
      const yaw = elementYaw(element.id);
      playgrounds.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z));
    } else if (element.type === "fitness_area") {
      const yaw = elementYaw(element.id);
      fitnessAreas.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z));
    } else if (element.type === "pergola") {
      const size = String(element.properties.size ?? "medium");
      const yaw = elementYaw(element.id);
      let batch = pergolasBySize.get(size);
      if (!batch) {
        batch = [];
        pergolasBySize.set(size, batch);
      }
      batch.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z));
    } else if (element.type === "traffic_signal") {
      trafficSignals.push(new THREE.Matrix4().setPosition(x, y, z));
    }
  }

  const meshes = [
    instanced(buildBenchGeometry(), furniture(materials), benches, "benches"),
    instanced(buildFountainGeometry(), waterFeature(materials), fountains, "water-features"),
    instanced(buildKioskGeometry(), kioskBody(materials), kiosks, "kiosks"),
    instanced(buildPlaygroundGeometry(), playgroundEquipment(materials), playgrounds, "playgrounds"),
    instanced(buildFitnessGeometry(), fitnessEquipment(materials), fitnessAreas, "fitness-areas"),
    ...[...pergolasBySize].map(([size, transforms]) =>
      instanced(buildPergolaGeometry(size), pergolaTimber(materials), transforms, `pergolas-${size}`)
    ),
    instanced(buildTrafficSignalGeometry(), trafficSignalMetal(materials), trafficSignals, "traffic-signals"),
  ];
  for (const mesh of meshes) if (mesh) group.add(mesh);
  return { object: group };
};
