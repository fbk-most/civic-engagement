/** Dev-only: a tree thinned by distance (`three/treeLod.ts`) next to the
 * same tree as drawn today, at a distance set by a slider — to judge the
 * thinning before the scene uses it. Like `treeLab.ts`, it uses the real
 * builders and materials, and isn't part of the shipped app:
 * http://localhost:5173/tree-lod-lab.html against `npm run dev`.
 *
 * Four cells, one canvas (see `treeLab.ts` for why): today's tree and the
 * thinned one, each as it shows on a screen `screen height` pixels high
 * (pixel for pixel: the cell is the middle of that screen) and magnified.
 * The thinning is always that of the real view, magnified or not.
 */

import * as THREE from "three";
import { loadFoliageAtlas } from "./three/assets";
import { buildBarkGeometry } from "./three/builders/branches";
import { buildLeafGeometry, SUMMER_PALETTE } from "./three/builders/foliageCards";
import { buildNeedleGeometry } from "./three/builders/needles";
import { buildTreeStructure, nodeBudgetFor, type CrownForm } from "./three/builders/treeStructure";
import { OVERVIEW_FOV_DEG } from "./three/camera";
import { MaterialLibrary } from "./three/materials";
import {
  barkOrder,
  barkTriangles,
  foliageOrder,
  foliageTriangles,
  keptShare,
  pixelsPerMetre,
  setBarkLod,
  setFoliageLod,
  sortTrianglesByKey,
  treeLodSettings,
} from "./three/treeLod";

const CELL_PX = 480;
const SEED = 90125;
const BARK_MAX_LEVEL = 6;
// The sun's shadow map: its texels about the size of the scene's on a site
// like Piazza Dante (some 460 m across, 4096 texels).
const SHADOW_HALF_M = 16;
const SHADOW_MAP_PX = 288;
const SHADOW_TEXEL_M = (2 * SHADOW_HALF_M) / SHADOW_MAP_PX;

interface Kind {
  label: string;
  crownForm: CrownForm;
  heightM: number;
  canopyDiameterM: number;
  /** Where the crown starts, as a share of the height (vegetation.ts). */
  crownBase: number;
}

const KINDS: Kind[] = [
  { label: "broadleaf, grown (14 m, crown 8 m)", crownForm: "round", heightM: 14, canopyDiameterM: 8, crownBase: 0.3 },
  { label: "broadleaf, young (9 m, crown 5 m)", crownForm: "round", heightM: 9, canopyDiameterM: 5, crownBase: 0.3 },
  { label: "broadleaf, sapling (5 m, crown 2.5 m)", crownForm: "round", heightM: 5, canopyDiameterM: 2.5, crownBase: 0.3 },
  { label: "pine (17 m, crown 7 m)", crownForm: "conical", heightM: 16.8, canopyDiameterM: 7, crownBase: 0.08 },
  { label: "cypress (14 m, crown 3.5 m)", crownForm: "columnar", heightM: 14, canopyDiameterM: 3.5, crownBase: 0.08 },
];

interface Sorted {
  mesh: THREE.Mesh;
  below: Uint32Array;
}

interface Tree {
  kind: Kind;
  box: THREE.Box3;
  /** Today's tree: all of it, but for the season's leaves. */
  reference: { scene: THREE.Scene; bark: number; leaves: Sorted | null; needles: number };
  thinned: { scene: THREE.Scene; bark: Sorted; leaves: Sorted | null; needles: Sorted | null };
}

function triangles(geometry: THREE.BufferGeometry): number {
  return (geometry.index ? geometry.index.count : geometry.getAttribute("position").count) / 3;
}

function stage(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdce6ec);
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(18, 30, 12);
  // A shadow map as coarse as the scene's (see SHADOW_TEXEL_M).
  sun.castShadow = true;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -SHADOW_HALF_M;
  sun.shadow.camera.right = sun.shadow.camera.top = SHADOW_HALF_M;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 80;
  sun.shadow.mapSize.set(SHADOW_MAP_PX, SHADOW_MAP_PX);
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(14, 48), new THREE.MeshStandardMaterial({ color: 0xbfd8a0, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  return scene;
}

function trunk(kind: Kind, material: THREE.Material): THREE.Mesh {
  const top = Math.max(kind.heightM * kind.crownBase, 0.3);
  const radius = Math.max(kind.canopyDiameterM / 20, 0.06);
  return new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.8, radius, top, 8).translate(0, top / 2, 0), material);
}

interface Materials {
  bark: THREE.Material;
  leaves: THREE.Material;
  needles: THREE.Material;
  trunk: THREE.Material;
  /** The thinned tree's shadow materials, by the material they go with. */
  shadows?: Map<THREE.Material, THREE.Material>;
}

function casting(mesh: THREE.Mesh, materials: Materials): THREE.Mesh {
  mesh.castShadow = true;
  const shadow = materials.shadows?.get(mesh.material as THREE.Material);
  if (shadow) mesh.customDepthMaterial = shadow;
  return mesh;
}

function buildTree(kind: Kind, sizedBudget: boolean, today: Materials, lod: Materials): Tree {
  const baseY = Math.max(kind.heightM * kind.crownBase, 0.3);
  // A crown with the whole budget is grown as today, so that the two trees
  // are the same one; a smaller budget is trimmed evenly (see `evenTrim`).
  const budget = nodeBudgetFor(kind.canopyDiameterM);
  const small = kind.crownForm === "round" && budget < nodeBudgetFor(Infinity);
  const structureOf = (sized: boolean) =>
    buildTreeStructure(SEED, baseY, kind.heightM, kind.canopyDiameterM, kind.crownForm, sized && small ? { nodeBudget: budget, evenTrim: true } : undefined);
  const foliage = (structure: ReturnType<typeof structureOf>) =>
    kind.crownForm === "round"
      ? { leaves: buildLeafGeometry(structure, SEED + 1, kind.canopyDiameterM, SUMMER_PALETTE), needles: null }
      : { leaves: null, needles: buildNeedleGeometry(structure, SEED + 1, 1) };

  // Today's tree.
  const full = structureOf(false);
  const fullFoliage = foliage(full);
  const fullBark = buildBarkGeometry(full, BARK_MAX_LEVEL);
  const referenceScene = stage();
  referenceScene.add(casting(trunk(kind, today.trunk), today), casting(new THREE.Mesh(fullBark, today.bark), today));
  let referenceLeaves: Sorted | null = null;
  if (fullFoliage.leaves) {
    const below = sortTrianglesByKey(fullFoliage.leaves, foliageOrder(fullFoliage.leaves));
    referenceLeaves = { mesh: casting(new THREE.Mesh(fullFoliage.leaves, today.leaves), today), below };
    referenceScene.add(referenceLeaves.mesh);
  }
  if (fullFoliage.needles) referenceScene.add(casting(new THREE.Mesh(fullFoliage.needles, today.needles), today));

  // The thinned one.
  const structure = structureOf(sizedBudget);
  const thinFoliage = foliage(structure);
  const sorted = (geometry: THREE.BufferGeometry, order: (geometry: THREE.BufferGeometry) => (vertex: number) => number, material: THREE.Material): Sorted => {
    const below = sortTrianglesByKey(geometry, order(geometry));
    const mesh = casting(new THREE.Mesh(geometry, material), lod);
    // The shader moves the vertices: a crown is never much larger than its
    // box, but the box of one tree, close up, isn't worth culling by.
    mesh.frustumCulled = false;
    return { mesh, below };
  };
  const bark = sorted(buildBarkGeometry(structure, BARK_MAX_LEVEL, { lod: true }), barkOrder, lod.bark);
  const leaves = thinFoliage.leaves ? sorted(thinFoliage.leaves, foliageOrder, lod.leaves) : null;
  const needles = thinFoliage.needles ? sorted(thinFoliage.needles, foliageOrder, lod.needles) : null;
  const thinnedScene = stage();
  thinnedScene.add(casting(trunk(kind, lod.trunk), lod), bark.mesh);
  if (leaves) thinnedScene.add(leaves.mesh);
  if (needles) thinnedScene.add(needles.mesh);

  const half = kind.canopyDiameterM / 2;
  return {
    kind,
    box: new THREE.Box3(new THREE.Vector3(-half, 0, -half), new THREE.Vector3(half, kind.heightM, half)),
    reference: { scene: referenceScene, bark: triangles(fullBark), leaves: referenceLeaves, needles: fullFoliage.needles ? triangles(fullFoliage.needles) : 0 },
    thinned: { scene: thinnedScene, bark, leaves, needles },
  };
}

function disposeTree(tree: Tree): void {
  for (const scene of [tree.reference.scene, tree.thinned.scene]) {
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }
}

/* ---- Controls ---- */

interface Slider {
  value: () => number;
  set: (value: number) => void;
}

function slider(parent: HTMLElement, label: string, min: number, max: number, start: number, options: { log?: boolean; digits?: number; unit?: string } = {}): Slider {
  const to = (v: number) => (options.log ? Math.log(v) : v);
  const from = (v: number) => (options.log ? Math.exp(v) : v);
  const wrap = document.createElement("label");
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(to(min));
  input.max = String(to(max));
  input.step = "any";
  input.value = String(to(start));
  const output = document.createElement("output");
  const show = () => (output.textContent = `${from(Number(input.value)).toFixed(options.digits ?? 0)}${options.unit ?? ""}`);
  input.addEventListener("input", show);
  show();
  wrap.append(label, input, output);
  parent.appendChild(wrap);
  return {
    value: () => from(Number(input.value)),
    set: (value) => {
      input.value = String(to(Math.min(max, Math.max(min, value))));
      show();
    },
  };
}

function checkbox(parent: HTMLElement, label: string, start: boolean, onChange?: () => void): () => boolean {
  const wrap = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = start;
  if (onChange) input.addEventListener("change", onChange);
  wrap.append(input, label);
  parent.appendChild(wrap);
  return () => input.checked;
}

async function main() {
  const controls = document.getElementById("controls");
  const container = document.getElementById("grid");
  if (!controls || !container) throw new Error("#controls or #grid missing from tree-lod-lab.html");

  // Two libraries: today's materials as they are, and a set that thins.
  const todayLibrary = new MaterialLibrary();
  const lodLibrary = new MaterialLibrary();
  await Promise.all([todayLibrary.ensureTextures(), lodLibrary.ensureTextures()]);
  const atlas = await loadFoliageAtlas();
  // Today's library is never told to thin; its bark is the plain one, for
  // today's branch geometry.
  const lodState = lodLibrary.treeLod;
  const eye = lodState.eye;
  const leafUniforms = lodState.leaves;
  const needleUniforms = lodState.needles;
  const barkUniforms = lodState.bark;
  const today: Materials = { bark: todayLibrary.bark(), leaves: todayLibrary.foliage(atlas), needles: todayLibrary.needles(), trunk: todayLibrary.bark() };
  const lod: Materials = { bark: lodLibrary.branches(), leaves: lodLibrary.foliage(atlas), needles: lodLibrary.needles(), trunk: lodLibrary.bark() };
  lod.shadows = new Map([
    [lod.bark, lodState.barkShadow.depth],
    [lod.leaves, lodState.leafShadow.depth],
    [lod.needles, lodState.needleShadow.depth],
  ]);

  const kindSelect = document.createElement("select");
  KINDS.forEach((kind, i) => kindSelect.add(new Option(kind.label, String(i))));
  const kindLabel = document.createElement("label");
  kindLabel.append("tree", kindSelect);
  controls.appendChild(kindLabel);

  const distance = slider(controls, "distance", 8, 800, 60, { log: true, unit: " m" });
  const detail = slider(controls, "detail", 0.25, 4, 1, { log: true, digits: 2 });
  const density = slider(controls, "leaves (season)", 0, 1, 1, { digits: 2 });
  const screenHeight = slider(controls, "screen height", 600, 2200, 1300, { unit: " px" });
  const floor = slider(controls, "least share", 0.005, 0.2, 0.03, { log: true, digits: 3 });
  const growExponent = slider(controls, "leaf growth", 0, 0.5, 0.5, { digits: 2 });
  const maxGrow = slider(controls, "largest growth", 1, 8, 4, { digits: 1, unit: "×" });
  const barkPx = slider(controls, "least branch width", 0.5, 3, 1, { digits: 1, unit: " px" });
  let tree: Tree | null = null;
  const rebuild = () => {
    if (tree) disposeTree(tree);
    tree = buildTree(KINDS[Number(kindSelect.value)], sizedBudget(), today, lod);
  };
  const sizedBudget = checkbox(controls, "branches by crown size (saplings)", true, rebuild);
  const sweep = checkbox(controls, "sweep the distance", false);
  const turn = checkbox(controls, "turn around the tree", true);
  kindSelect.addEventListener("change", rebuild);
  // A view to come back to, or to capture: ?tree=3&distance=300&detail=0.5
  // (and &still to stop the turning).
  const query = new URLSearchParams(window.location.search);
  if (query.has("tree")) kindSelect.value = String(Math.min(KINDS.length - 1, Math.max(0, Number(query.get("tree")) || 0)));
  if (query.has("distance")) distance.set(Number(query.get("distance")));
  if (query.has("detail")) detail.set(Number(query.get("detail")));
  if (query.has("leaves")) density.set(Number(query.get("leaves")));
  const still = query.has("still");
  rebuild();

  // One canvas pixel is one screen pixel, as in the app (whose pixel ratio
  // is the screen's, up to 2).
  const ratio = Math.min(window.devicePixelRatio, 2);
  const size = CELL_PX * 2;
  container.style.width = `${size / ratio}px`;
  container.style.height = `${size / ratio}px`;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  canvas.style.width = `${size / ratio}px`;
  canvas.style.height = `${size / ratio}px`;
  container.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setScissorTest(true);

  const captions = [0, 1, 2, 3].map((i) => {
    const caption = document.createElement("pre");
    caption.className = "caption";
    caption.style.left = `${((i % 2) * CELL_PX) / ratio}px`;
    caption.style.top = `${(Math.floor(i / 2) * CELL_PX) / ratio}px`;
    container.appendChild(caption);
    return caption;
  });

  const camera = new THREE.PerspectiveCamera(OVERVIEW_FOV_DEG, 1, 0.1, 2000);
  const target = new THREE.Vector3();
  const PITCH = (18 * Math.PI) / 180;
  const fovOf = (halfTan: number) => (2 * Math.atan(halfTan) * 180) / Math.PI;
  let yaw = 0.6;
  let last = performance.now();
  let sweepPhase = 0;

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    if (!tree) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (turn() && !still) yaw += dt * 0.25;
    if (sweep()) {
      // Back and forth on a log scale, 10 m to 600 m in 12 s.
      sweepPhase += dt / 12;
      const share = 0.5 - 0.5 * Math.cos(sweepPhase * Math.PI);
      distance.set(Math.exp(Math.log(10) + share * (Math.log(600) - Math.log(10))));
    }

    const d = distance.value();
    const kind = tree.kind;
    target.set(0, kind.heightM * 0.55, 0);
    camera.position.set(Math.cos(yaw) * Math.cos(PITCH) * d, target.y + Math.sin(PITCH) * d, Math.sin(yaw) * Math.cos(PITCH) * d);
    camera.lookAt(target);
    eye.value.copy(camera.position);

    const pxPerM = pixelsPerMetre(OVERVIEW_FOV_DEG, screenHeight.value());
    const settings = treeLodSettings(detail.value(), pxPerM, { floor: floor.value(), growExponent: growExponent.value(), maxGrow: maxGrow.value(), barkPx: barkPx.value() });
    const leafDensity = density.value();
    setFoliageLod(leafUniforms, settings.leaves, leafDensity);
    setFoliageLod(needleUniforms, settings.needles);
    setBarkLod(barkUniforms, settings);
    // The shadows: coarser, as in the scene (see `updateTreeLod`).
    const tuning = { floor: floor.value(), growExponent: growExponent.value(), maxGrow: maxGrow.value() };
    const shadow = treeLodSettings(detail.value() * 0.5, pxPerM, tuning);
    shadow.barkSlope = settings.barkSlope * 2;
    shadow.barkFloor = SHADOW_TEXEL_M / 2;
    setFoliageLod(lodState.shadowLeaves, shadow.leaves, leafDensity);
    setFoliageLod(lodState.shadowNeedles, shadow.needles);
    setBarkLod(lodState.shadowBark, shadow);

    const nearest = tree.box.distanceToPoint(camera.position);
    const { reference, thinned } = tree;
    let referenceLeaves = 0;
    if (reference.leaves) {
      referenceLeaves = reference.leaves.below[Math.round(leafDensity * (reference.leaves.below.length - 1))];
      reference.leaves.mesh.geometry.setDrawRange(0, referenceLeaves * 3);
    }
    const bark = barkTriangles(thinned.bark.below, settings, nearest);
    thinned.bark.mesh.geometry.setDrawRange(0, bark * 3);
    let foliage = 0;
    if (thinned.leaves) {
      foliage = foliageTriangles(thinned.leaves.below, settings.leaves, nearest, leafDensity);
      thinned.leaves.mesh.geometry.setDrawRange(0, foliage * 3);
    }
    if (thinned.needles) {
      foliage = foliageTriangles(thinned.needles.below, settings.needles, nearest);
      thinned.needles.mesh.geometry.setDrawRange(0, foliage * 3);
    }

    // The top row: the middle CELL_PX of a screen `screenHeight` high. The
    // bottom row: the tree filling the cell, and never smaller than above.
    const real = (Math.tan((OVERVIEW_FOV_DEG * Math.PI) / 360) * CELL_PX) / screenHeight.value();
    const fill = Math.min(real, (Math.max(kind.heightM, kind.canopyDiameterM) * 0.62) / d);
    [real, fill].forEach((halfTan, row) => {
      camera.fov = fovOf(halfTan);
      camera.updateProjectionMatrix();
      [reference.scene, thinned.scene].forEach((scene, col) => {
        const x = col * CELL_PX;
        const y = size - (row + 1) * CELL_PX;
        renderer.setViewport(x, y, CELL_PX, CELL_PX);
        renderer.setScissor(x, y, CELL_PX, CELL_PX);
        renderer.render(scene, camera);
      });
    });

    const referenceFoliage = referenceLeaves + reference.needles;
    const share = thinned.needles ? keptShare(settings.needles, d) : keptShare(settings.leaves, d);
    const fullAt = thinned.needles ? settings.needles.d0 : settings.leaves.d0;
    const before = reference.bark + referenceFoliage;
    const after = bark + foliage;
    const count = (n: number) => n.toLocaleString("en");
    captions[0].textContent = `today: ${count(before)} triangles\nbark ${count(reference.bark)}, foliage ${count(referenceFoliage)}`;
    captions[1].textContent =
      `thinned: ${count(after)} triangles sent (${((after / before) * 100).toFixed(1)}%)\nbark ${count(bark)}, foliage ${count(foliage)}\n` +
      `foliage drawn ${(share * 100).toFixed(1)}%, all of it up to ${fullAt.toFixed(0)} m`;
    captions[2].textContent = `today, magnified ×${(real / fill).toFixed(1)}`;
    captions[3].textContent = `thinned, magnified ×${(real / fill).toFixed(1)}`;
  };
  requestAnimationFrame(frame);
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.setAttribute("data-ready", "1")));
}

main().catch((err) => {
  console.error(err);
  document.body.setAttribute("data-ready", "error");
});
