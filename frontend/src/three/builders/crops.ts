/** The plants of the cultivated covers ("coltiva il terreno"), in the realistic
 * view: what grows on the soil `buildGround` draws for them.
 *
 * One look per purpose, so the three read apart at a glance:
 *
 * - `crop_field` (commercial): long, regular rows of one low crop, aligned
 *   with the field, turning from green to gold as it ripens;
 * - `flowerbed` (botanical): a dense, irregular carpet of small flowers in
 *   patches of colour;
 * - `vegetable_garden` (gardening): narrow raised beds with paths between
 *   them, each bed its own vegetable.
 *
 * Everything is procedural and deterministic (seeded by the cover's id, so a
 * reload or the 2D/3D tabs agree) and drawn as instanced meshes. The plants
 * are visual only: where they stand is not part of what the model computes.
 *
 * Every plant is placed from a growth between 0 (bare soil) and 1 (fully
 * grown), set with `setCropGrowth`: the shape of the field does not change
 * with the season, only how grown its plants are, so the season can drive
 * them without rebuilding anything.
 */

import * as THREE from "three";
import type { CoverPolygon, CoverType } from "../../api/types";
import { polygonRings, toLocal, type GeoAnchor } from "../geo";
import { hashString } from "../hash";
import type { MaterialLibrary } from "../materials";

export const CROP_COVER_TYPES: CoverType[] = ["crop_field", "flowerbed", "vegetable_garden"];

/** Plants never stand lower than the top of the cover band the soil is drawn
 * in (see `shapes.ts`'s COVER_BAND_M). The one place a terrain height would
 * be added to. */
const GROUND_Y_M = 0.01;

/** A ceiling on the plants of one polygon: a big field gets its rows spaced
 * further apart rather than drawing hundreds of thousands of them. */
const MAX_PLANTS_PER_POLYGON = 12000;

const FLOWER_COLORS = [0xe94b6b, 0xf2c14e, 0xf7f3ec, 0x9b5de5, 0xff8a3d, 0x4cc9f0];
const BED_COLORS = [0x86b556, 0x5e9a52, 0x8b5a8c, 0xc65d3f, 0xa7c957, 0x3f7f4a];
const CROP_GREEN = new THREE.Color(0x6fa34a);
const CROP_RIPE = new THREE.Color(0xd8b84e);

type Ring = [number, number][]; // local [x, z], metres
type Polygon = Ring[]; // outer ring, then holes

interface Plant {
  x: number;
  z: number;
  yaw: number;
  /** 0.8 to 1.2: no two plants are the same size. */
  size: number;
  /** 0 to 1: staggers when each plant grows, so a field does not pop up whole. */
  phase: number;
  /** Which colour (flowerbed, garden), or how far from the field's average (crop). */
  tint: number;
}

export interface CropField {
  coverType: CoverType;
  plantCount: number;
  /** Places every plant for a growth from 0 to 1. */
  update: (growth: number) => void;
  meshes: THREE.InstancedMesh[];
}

export interface Crops {
  group: THREE.Group;
  fields: CropField[];
  geometries: THREE.BufferGeometry[];
}

// --- plane geometry ------------------------------------------------------------

function localPolygons(geometry: GeoJSON.Geometry, anchor: GeoAnchor): Polygon[] {
  return polygonRings(geometry).map((rings) =>
    rings.map((ring) => ring.map(([lng, lat]) => toLocal(anchor, lng, lat)))
  );
}

/** Even-odd: inside the outer ring and outside every hole. */
function contains(polygon: Polygon, x: number, z: number): boolean {
  let inside = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
}

function ringArea(ring: Ring): number {
  let twice = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    twice += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(twice) / 2;
}

function polygonArea(polygon: Polygon): number {
  return polygon.reduce((area, ring, i) => area + (i === 0 ? ringArea(ring) : -ringArea(ring)), 0);
}

/** Direction (radians) of the longest edge of the outer ring: the way rows
 * and beds run, so they follow the shape drawn. */
function longestEdgeAngle(polygon: Polygon): number {
  const ring = polygon[0];
  let best = 0;
  let angle = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const dx = ring[i][0] - ring[j][0];
    const dz = ring[i][1] - ring[j][1];
    const length = Math.hypot(dx, dz);
    if (length > best) {
      best = length;
      angle = Math.atan2(dz, dx);
    }
  }
  return angle;
}

/** Seeded random numbers in [0, 1) (mulberry32). */
function random(seed: string): () => number {
  let state = hashString(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points on a grid aligned with `angle`, `pitchAcross` between rows and
 * `pitchAlong` along them, that fall inside the polygon. `row` counts rows
 * across, `column` along. The pitches grow if the field would have more than
 * MAX_PLANTS_PER_POLYGON plants. */
function gridPoints(
  polygon: Polygon,
  angle: number,
  pitchAcross: number,
  pitchAlong: number
): { x: number; z: number; row: number; column: number }[] {
  const expected = polygonArea(polygon) / (pitchAcross * pitchAlong);
  const spread = expected > MAX_PLANTS_PER_POLYGON ? Math.sqrt(expected / MAX_PLANTS_PER_POLYGON) : 1;
  const across = pitchAcross * spread;
  const along = pitchAlong * spread;

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // The polygon in the frame of the rows: u along them, v across.
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [x, z] of polygon[0]) {
    const u = x * cos + z * sin;
    const v = -x * sin + z * cos;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }

  const points: { x: number; z: number; row: number; column: number }[] = [];
  for (let row = 0, v = minV + across / 2; v < maxV; row++, v += across) {
    for (let column = 0, u = minU + along / 2; u < maxU; column++, u += along) {
      const x = u * cos - v * sin;
      const z = u * sin + v * cos;
      if (contains(polygon, x, z)) points.push({ x, z, row, column });
    }
  }
  return points;
}

// --- one layout per purpose -----------------------------------------------------

function plant(x: number, z: number, yaw: number, rand: () => number, tint: number): Plant {
  return { x, z, yaw, size: 0.8 + 0.4 * rand(), phase: rand(), tint };
}

/** Commercial: straight rows 0.75 m apart, a plant every 0.4 m. */
function cropRows(polygon: Polygon, rand: () => number): Plant[] {
  const angle = longestEdgeAngle(polygon);
  return gridPoints(polygon, angle, 0.75, 0.4).map((p) =>
    plant(p.x + (rand() - 0.5) * 0.06, p.z + (rand() - 0.5) * 0.06, rand() * Math.PI, rand, rand())
  );
}

/** Botanical: flowers jostled off a fine grid, coloured in patches. */
function flowerCarpet(polygon: Polygon, rand: () => number, seed: string): Plant[] {
  const patchColor = (px: number, pz: number) =>
    // A colour per 2.5 m patch, from the patch's position so it is the same wherever it is asked.
    Math.floor(random(`${seed}:${Math.floor(px / 2.5)}:${Math.floor(pz / 2.5)}`)() * FLOWER_COLORS.length);
  return gridPoints(polygon, 0, 0.38, 0.38).map((p) => {
    const x = p.x + (rand() - 0.5) * 0.3;
    const z = p.z + (rand() - 0.5) * 0.3;
    // One flower in six breaks the patch's colour.
    const tint = rand() < 0.17 ? Math.floor(rand() * FLOWER_COLORS.length) : patchColor(x, z);
    return plant(x, z, rand() * Math.PI * 2, rand, tint);
  });
}

/** Gardening: beds of three rows 0.4 m apart, then a path one row wide, each
 * bed its own vegetable. */
function vegetableBeds(polygon: Polygon, rand: () => number): Plant[] {
  const angle = longestEdgeAngle(polygon);
  const plants: Plant[] = [];
  for (const p of gridPoints(polygon, angle, 0.4, 0.42)) {
    const bed = Math.floor(p.row / 4);
    if (p.row % 4 === 3) continue; // the path
    plants.push(plant(p.x + (rand() - 0.5) * 0.04, p.z + (rand() - 0.5) * 0.04, rand() * Math.PI * 2, rand, bed % BED_COLORS.length));
  }
  return plants;
}

// --- placing plants ------------------------------------------------------------

const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const rotation = new THREE.Quaternion();
const scale = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const color = new THREE.Color();

function place(
  mesh: THREE.InstancedMesh,
  index: number,
  p: Plant,
  height: number,
  scaleX: number,
  scaleY: number
): void {
  rotation.setFromAxisAngle(UP, p.yaw);
  position.set(p.x, GROUND_Y_M + height, p.z);
  scale.set(scaleX, scaleY, scaleX);
  mesh.setMatrixAt(index, matrix.compose(position, rotation, scale));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** How grown one plant is, given the field's growth: each is a little ahead or
 * behind its neighbours. */
function grown(growth: number, p: Plant): number {
  return Math.min(1, Math.max(0, growth * (0.8 + 0.4 * p.phase)));
}

function instanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  count: number,
  name: string
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.receiveShadow = true;
  // The plants are small and many: their shadows cost far more than they show.
  mesh.castShadow = false;
  // The bounds of an instanced mesh are those of its one geometry at the
  // origin, so every field would be culled as one blob (see vegetation.ts).
  mesh.frustumCulled = false;
  return mesh;
}

// --- the fields ----------------------------------------------------------------

function geometries(): Record<string, THREE.BufferGeometry> {
  const crop = new THREE.ConeGeometry(0.07, 0.75, 5);
  crop.translate(0, 0.375, 0);
  const stem = new THREE.CylinderGeometry(0.012, 0.016, 0.4, 4);
  stem.translate(0, 0.2, 0);
  const head = new THREE.IcosahedronGeometry(0.09, 0);
  const leafy = new THREE.IcosahedronGeometry(0.2, 1);
  leafy.scale(1, 0.75, 1);
  leafy.translate(0, 0.15, 0);
  return { crop, stem, head, leafy };
}

export function buildCrops(covers: CoverPolygon[], anchor: GeoAnchor, materials: MaterialLibrary): Crops {
  const group = new THREE.Group();
  group.name = "crops";
  const shapes = geometries();
  const fields: CropField[] = [];

  for (const cover of covers) {
    if (!CROP_COVER_TYPES.includes(cover.cover_type)) continue;
    localPolygons(cover.geometry, anchor).forEach((polygon, index) => {
      const seed = `${cover.id}:${index}`;
      const rand = random(seed);
      let field: CropField | null = null;
      if (cover.cover_type === "crop_field") field = cropField(cropRows(polygon, rand), shapes, materials, seed);
      else if (cover.cover_type === "flowerbed") field = flowerbed(flowerCarpet(polygon, rand, seed), shapes, materials, seed);
      else if (cover.cover_type === "vegetable_garden") field = vegetableGarden(vegetableBeds(polygon, rand), shapes, materials, seed);
      if (!field || field.plantCount === 0) return;
      for (const mesh of field.meshes) group.add(mesh);
      fields.push(field);
    });
  }
  return { group, fields, geometries: Object.values(shapes) };
}

function cropField(
  plants: Plant[],
  shapes: Record<string, THREE.BufferGeometry>,
  materials: MaterialLibrary,
  seed: string
): CropField {
  const mesh = instanced(shapes.crop, materials.cropPlant(), plants.length, `crop-field-${seed}`);
  return {
    coverType: "crop_field",
    plantCount: plants.length,
    meshes: [mesh],
    update(growth) {
      mesh.visible = growth > 0.01;
      plants.forEach((p, i) => {
        const g = grown(growth, p);
        // Low and narrow at first, then tall, and ripening to gold at the end.
        place(mesh, i, p, 0, p.size * (0.5 + 0.5 * g), p.size * g);
        mesh.setColorAt(i, color.copy(CROP_GREEN).lerp(CROP_RIPE, smoothstep(0.55, 1, g)).offsetHSL(0, 0, (p.tint - 0.5) * 0.08));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
  };
}

function flowerbed(
  plants: Plant[],
  shapes: Record<string, THREE.BufferGeometry>,
  materials: MaterialLibrary,
  seed: string
): CropField {
  const stems = instanced(shapes.stem, materials.cropStem(), plants.length, `flowerbed-stems-${seed}`);
  const heads = instanced(shapes.head, materials.cropPlant(), plants.length, `flowerbed-heads-${seed}`);
  plants.forEach((p, i) => heads.setColorAt(i, color.set(FLOWER_COLORS[p.tint])));
  if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
  return {
    coverType: "flowerbed",
    plantCount: plants.length,
    meshes: [stems, heads],
    update(growth) {
      stems.visible = heads.visible = growth > 0.01;
      plants.forEach((p, i) => {
        const g = grown(growth, p);
        place(stems, i, p, 0, p.size, p.size * g);
        // The flowers open late: a stem is green for a while before it blooms.
        const bloom = smoothstep(0.5, 1, g);
        place(heads, i, p, 0.4 * p.size * g + 0.02, p.size * bloom, p.size * bloom);
      });
      stems.instanceMatrix.needsUpdate = true;
      heads.instanceMatrix.needsUpdate = true;
    },
  };
}

function vegetableGarden(
  plants: Plant[],
  shapes: Record<string, THREE.BufferGeometry>,
  materials: MaterialLibrary,
  seed: string
): CropField {
  const mesh = instanced(shapes.leafy, materials.cropPlant(), plants.length, `vegetable-garden-${seed}`);
  plants.forEach((p, i) => mesh.setColorAt(i, color.set(BED_COLORS[p.tint]).offsetHSL(0, 0, (p.phase - 0.5) * 0.06)));
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return {
    coverType: "vegetable_garden",
    plantCount: plants.length,
    meshes: [mesh],
    update(growth) {
      mesh.visible = growth > 0.01;
      plants.forEach((p, i) => {
        const g = grown(growth, p);
        place(mesh, i, p, 0, p.size * (0.35 + 0.65 * g), p.size * (0.2 + 0.8 * g));
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

/** Grows every field to `growthOf(its cover type)`: 0 is bare soil, 1 fully grown. */
export function setCropGrowth(crops: Crops, growthOf: (coverType: CoverType) => number): void {
  for (const field of crops.fields) field.update(growthOf(field.coverType));
}

/** The plants own their geometry and instance buffers; the materials are the
 * library's. */
export function disposeCrops(crops: Crops): void {
  for (const field of crops.fields) for (const mesh of field.meshes) mesh.dispose();
  for (const geometry of crops.geometries) geometry.dispose();
}
