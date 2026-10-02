/** Dev-only tree parameter sweep — see the plan this was built from for why:
 * tuning branch/leaf density by rebuilding the whole demo scene and
 * eyeballing one screenshot at a time made comparing options nearly
 * impossible. This renders many independently-configured trees side by
 * side, using the *real* production builders (`treeStructure.ts`,
 * `branches.ts`, `foliageCards.ts`, `needles.ts`, `materials.ts`) so the
 * comparison is trustworthy, not a simplified stand-in.
 *
 * One shared `WebGLRenderer`/canvas for the whole grid, each cell drawn
 * into its own region via scissor+viewport, rather than one `<canvas>` (and
 * WebGL context) per cell — a first version used one context per tree and
 * most cells silently came back blank once the count climbed past the
 * browser's simultaneous-WebGL-context limit, with no error, just an empty
 * cell. Scissoring avoids that entirely: still one GPU context for the
 * whole page, however many trees are being compared.
 *
 * Not part of the shipped app — `tree-lab.html` is a second, unregistered
 * Vite HTML entry, so `vite build` (which only processes `index.html`
 * unless told otherwise) never includes it. Open http://localhost:5173/tree-lab.html
 * against a running `npm run dev` to view it live, or capture it headlessly
 * with `scripts/capture-tree-lab.mjs`.
 *
 * Current sweep: evergreen (conical/columnar) shape, plus a needle
 * width x count grid — needle *shape* (as opposed to branch structure) went
 * through several rounds of one-value-at-a-time guessing against live-scene
 * screenshots ("too fat/frond-like" -> "too sparse/vanishing" -> "still not
 * enough") before anyone asked for a real side-by-side comparison the way
 * the crown-structure sweep already had; this is that, for needles. The
 * round-form VARIANTS from the original broadleaf sweep are kept in git
 * history — swap `VARIANTS` back to `ROUND_VARIANTS` if broadleaf needs
 * revisiting.
 */

import * as THREE from "three";
import { MaterialLibrary } from "./three/materials";
import { buildBarkGeometry } from "./three/builders/branches";
import { buildNeedleGeometry, type NeedleOptions } from "./three/builders/needles";
import {
  buildTreeStructure,
  type ConiferOverrides,
  type CrownForm,
  type TreeStructureOptions,
} from "./three/builders/treeStructure";

// Fixed for every variant, so the only thing that differs cell-to-cell is
// the parameter actually being tested — a real controlled comparison, not
// "these also happen to be different sizes/species".
const HEIGHT_M = 9;
const CANOPY_DIAMETER_M = 5.5; // conifers are narrower than the broadleaf sweep's 7m
const BASE_Y = 2.7; // matches vegetation.ts's own trunkTop formula for this height
const SEED = 90125;

// 3 columns so the needle width x count sweep below renders as a legible
// matrix (3 widths x 3 counts) rather than wrapping mid-row at 4.
const COLS = 3;
// Raised from 300: at that size a close-up cell is only 300 real pixels
// across, too coarse to judge individual needle width/spacing from a
// screenshot — this is the actual render resolution (canvas width/height
// are set directly from this, not scaled via CSS), not just a display size.
const CELL_PX = 520;
const CAPTION_PX = 56;

interface Variant {
  label: string;
  crownForm: CrownForm;
  structureOptions?: TreeStructureOptions;
  barkRenderMaxLevel: number;
  leaves: boolean;
  canopyDiameterM?: number;
  // Only conifer() sets these — real conifers are much taller relative to
  // canopy width than the shared HEIGHT_M/BASE_Y this file otherwise uses,
  // see REAL_HEIGHT_TO_CANOPY_RATIO above.
  heightM?: number;
  baseYM?: number;
  // Rendered with a second, much closer camera (see main()) instead of the
  // shared whole-tree one — needed after the whole-tree framing (sized to
  // fit all variants for side-by-side comparison) turned out too zoomed-out
  // to judge individual needle shape/density at all: a real regression in
  // this tool's usefulness, not just a rendering nicety, found while
  // checking whether shrinking NEEDLE_LENGTH_M/WIDTH_M actually worked.
  closeUp?: boolean;
  needleOptions?: NeedleOptions;
}

const UNCAPPED_BARK_LEVEL = 12;

// Real per-species mature canopy diameters from civic_twin/domains/urban/parameters.py's
// SPECIES_GROWTH — the shared 5.5m test width used elsewhere in this file
// is deliberately generic for comparing forms against each other, but a
// real cypress is meant to be much narrower than a real pine/fir, and that
// difference matters for judging whether "columnar" actually reads as
// narrow.
const REAL_CANOPY_DIAMETER_M: Record<"conical" | "columnar", number> = {
  conical: 7.0, // pine
  columnar: 3.5, // cypress
};

// Mirrors parameters.py's HEIGHT_TO_CANOPY_RATIO_BY_FORM and vegetation.ts's
// CROWN_BASE_FRACTION_EVERGREEN — conifers are tall spires with a much
// smaller canopy:height ratio, and branch nearly to the ground, unlike the
// pruned broadleaf HEIGHT_M/BASE_Y this file otherwise shares across
// variants. Using the real formulas here (not just the real diameter) is
// what makes this comparison trustworthy for judging the height fix too.
const REAL_HEIGHT_TO_CANOPY_RATIO: Record<"conical" | "columnar", number> = {
  conical: 2.4,
  columnar: 4.0,
};
const CROWN_BASE_FRACTION_EVERGREEN = 0.08;

function conifer(
  label: string,
  crownForm: "conical" | "columnar",
  overrides: ConiferOverrides,
  leaves: boolean,
  closeUp = false
): Variant {
  const canopyDiameterM = REAL_CANOPY_DIAMETER_M[crownForm];
  const heightM = canopyDiameterM * REAL_HEIGHT_TO_CANOPY_RATIO[crownForm];
  return {
    label,
    crownForm,
    structureOptions: { conifer: overrides },
    barkRenderMaxLevel: UNCAPPED_BARK_LEVEL,
    leaves,
    canopyDiameterM,
    heightM,
    baseYM: Math.max(heightM * CROWN_BASE_FRACTION_EVERGREEN, 0.3),
    closeUp,
  };
}

// Needle width x count sweep — the shipped values (needles.ts's own
// NEEDLE_WIDTH_M/NEEDLES_PER_TWIG_RANGE) are the 0.012 / [32,46] cell;
// widths and counts on either side let a width/density tradeoff actually be
// compared instead of edited one value at a time. All close-up (see
// Variant.closeUp) since the whole-tree camera can't resolve needle detail
// at all — that's what made the first two rounds of width tuning slow.
const NEEDLE_SWEEP_WIDTHS_M = [0.008, 0.012, 0.02];
const NEEDLE_SWEEP_COUNT_RANGES: [number, number][] = [
  [20, 30],
  [32, 46],
  [55, 75],
];

function needleSweepVariant(widthM: number, countRange: [number, number]): Variant {
  const canopyDiameterM = REAL_CANOPY_DIAMETER_M.conical;
  const heightM = canopyDiameterM * REAL_HEIGHT_TO_CANOPY_RATIO.conical;
  return {
    label: `pine needles\nw=${widthM}m n=${countRange[0]}-${countRange[1]}`,
    crownForm: "conical",
    structureOptions: {},
    barkRenderMaxLevel: UNCAPPED_BARK_LEVEL,
    leaves: true,
    canopyDiameterM,
    heightM,
    baseYM: Math.max(heightM * CROWN_BASE_FRACTION_EVERGREEN, 0.3),
    closeUp: true,
    needleOptions: { widthM, countRange },
  };
}

const NEEDLE_SWEEP: Variant[] = NEEDLE_SWEEP_WIDTHS_M.flatMap((widthM) =>
  NEEDLE_SWEEP_COUNT_RANGES.map((countRange) => needleSweepVariant(widthM, countRange))
);

// Follow-up: the width x count sweep above plateaued — even its densest
// corner (w=0.02, n=55-75) only read as modestly fuller than its sparsest,
// which points at something other than per-needle size/count capping
// perceived volume. Cone angle is the next suspect: at 15° (shipped),
// every needle from one anchor points in nearly the same direction as the
// twig, so a cluster reads as a flat tuft rather than a 3D puff regardless
// of how many needles it has. Fixed at the width/count sweep's fullest
// corner so this isolates cone angle and length specifically.
const CONE_SWEEP_DEG = [15, 30, 45, 60];
const CONE_SWEEP_LENGTHS_M = [0.25, 0.35];
const CONE_SWEEP_WIDTH_M = 0.02;
const CONE_SWEEP_COUNT_RANGE: [number, number] = [55, 75];

function coneSweepVariant(coneDeg: number, lengthM: number): Variant {
  const canopyDiameterM = REAL_CANOPY_DIAMETER_M.conical;
  const heightM = canopyDiameterM * REAL_HEIGHT_TO_CANOPY_RATIO.conical;
  return {
    label: `pine needles\ncone=${coneDeg}deg len=${lengthM}m`,
    crownForm: "conical",
    structureOptions: {},
    barkRenderMaxLevel: UNCAPPED_BARK_LEVEL,
    leaves: true,
    canopyDiameterM,
    heightM,
    baseYM: Math.max(heightM * CROWN_BASE_FRACTION_EVERGREEN, 0.3),
    closeUp: true,
    needleOptions: { coneDeg, lengthM, widthM: CONE_SWEEP_WIDTH_M, countRange: CONE_SWEEP_COUNT_RANGE },
  };
}

const CONE_SWEEP: Variant[] = CONE_SWEEP_DEG.flatMap((coneDeg) =>
  CONE_SWEEP_LENGTHS_M.map((lengthM) => coneSweepVariant(coneDeg, lengthM))
);

const VARIANTS: Variant[] = [
  conifer("conical (pine/fir)\nshipped, bare\nreal diam 7m", "conical", {}, false),
  conifer("conical (pine/fir)\nshipped, needles\nreal diam 7m", "conical", {}, true),
  conifer("columnar (cypress)\nshipped, bare\nreal diam 3.5m", "columnar", {}, false),
  conifer("columnar (cypress)\nshipped, needles\nreal diam 3.5m", "columnar", {}, true),
  conifer("conical (pine/fir)\nCLOSE-UP, needles\nreal diam 7m", "conical", {}, true, true),
  conifer("columnar (cypress)\nCLOSE-UP, needles\nreal diam 3.5m", "columnar", {}, true, true),
  ...NEEDLE_SWEEP,
  ...CONE_SWEEP,
];

function buildScene(variant: Variant, materials: MaterialLibrary): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdce6ec);

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(6, 10, 4);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(6, 24),
    new THREE.MeshStandardMaterial({ color: 0xbfd8a0, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const canopyDiameterM = variant.canopyDiameterM ?? CANOPY_DIAMETER_M;
  const heightM = variant.heightM ?? HEIGHT_M;
  const baseY = variant.baseYM ?? BASE_Y;
  const structure = buildTreeStructure(SEED, baseY, heightM, canopyDiameterM, variant.crownForm, variant.structureOptions);

  scene.add(new THREE.Mesh(buildBarkGeometry(structure, variant.barkRenderMaxLevel), materials.bark()));

  const trunkRadius = Math.max(canopyDiameterM / 20, 0.06);
  const trunkGeometry = new THREE.CylinderGeometry(trunkRadius, trunkRadius * 1.25, baseY, 8);
  trunkGeometry.translate(0, baseY / 2, 0);
  scene.add(new THREE.Mesh(trunkGeometry, materials.bark()));

  if (variant.leaves) {
    const needles = buildNeedleGeometry(structure, SEED + 1, 1, variant.needleOptions);
    if (needles) scene.add(new THREE.Mesh(needles, materials.needles()));
  }

  return scene;
}

async function main() {
  const materials = new MaterialLibrary();
  await materials.ensureTextures();
  const container = document.getElementById("grid");
  if (!container) throw new Error("#grid missing from tree-lab.html");

  const rows = Math.ceil(VARIANTS.length / COLS);
  const canvasWidth = COLS * CELL_PX;
  const canvasHeight = rows * (CELL_PX + CAPTION_PX);

  container.style.position = "relative";
  container.style.width = `${canvasWidth}px`;
  container.style.height = `${canvasHeight}px`;

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  canvas.style.position = "absolute";
  canvas.style.top = "0";
  canvas.style.left = "0";
  container.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(canvasWidth, canvasHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setScissorTest(true);

  // Framed for the tallest variant actually in VARIANTS, not the generic
  // HEIGHT_M — currently that's the real conifer heights (up to ~17m for
  // pine), well past what HEIGHT_M=9's old framing fit.
  const maxHeightM = Math.max(HEIGHT_M, ...VARIANTS.map((v) => v.heightM ?? 0));
  const camera = new THREE.PerspectiveCamera(45, CELL_PX / CELL_PX, 0.1, 200);
  camera.position.set(maxHeightM * 1.05, maxHeightM * 0.6, maxHeightM * 1.05);
  camera.lookAt(0, maxHeightM * 0.42, 0);

  // Close-up camera for `closeUp` variants — the whole-tree camera above is
  // sized to fit ~17m of tree in a 300px cell (~15px/metre), fine for
  // silhouette/structure comparison but far too coarse to judge individual
  // needle shape or density; this instead frames a ~4-5m tall slice of
  // mid-crown, at typical inspection distance, aimed per-variant since pine
  // and cypress crown heights differ.
  const closeUpCamera = new THREE.PerspectiveCamera(45, CELL_PX / CELL_PX, 0.1, 200);

  VARIANTS.forEach((variant, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = col * CELL_PX;
    const yFromTop = row * (CELL_PX + CAPTION_PX);
    // WebGL viewport/scissor Y is measured from the bottom of the canvas,
    // CSS/DOM Y from the top — this is the conversion between the two.
    const yFromBottom = canvasHeight - yFromTop - CELL_PX;

    let activeCamera: THREE.PerspectiveCamera = camera;
    if (variant.closeUp) {
      const targetY = (variant.heightM ?? HEIGHT_M) * 0.45;
      closeUpCamera.position.set(4.5, targetY + 2, 4.5);
      closeUpCamera.lookAt(0, targetY, 0);
      activeCamera = closeUpCamera;
    }

    renderer.setViewport(x, yFromBottom, CELL_PX, CELL_PX);
    renderer.setScissor(x, yFromBottom, CELL_PX, CELL_PX);
    renderer.render(buildScene(variant, materials), activeCamera);

    const caption = document.createElement("pre");
    caption.className = "caption";
    caption.textContent = variant.label;
    caption.style.position = "absolute";
    caption.style.left = `${x}px`;
    caption.style.top = `${yFromTop + CELL_PX}px`;
    caption.style.width = `${CELL_PX}px`;
    caption.style.height = `${CAPTION_PX}px`;
    container.appendChild(caption);
  });

  // Double rAF: waits for the browser to have actually painted before
  // signalling ready, not just for our synchronous render() calls to have
  // returned — capture-tree-lab.mjs waits on this attribute.
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.setAttribute("data-ready", "1")));
}

main().catch((err) => {
  console.error(err);
  document.body.setAttribute("data-ready", "error");
});
