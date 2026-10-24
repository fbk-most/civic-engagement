/** Procedural facade texture: one bay of wall, tiled across every building.
 *
 * Drawn rather than downloaded because it has to be *scaled in metres*, not in
 * pixels. `ExtrudeGeometry`'s side-wall UVs are in world units, so setting
 * `repeat` to 1/bay-width by 1/storey-height puts exactly one window per storey
 * at the right size on a building of any height — which a photographed facade
 * sheet, with its own fixed number of floors baked in, cannot do.
 *
 * A flat-coloured box is the single thing that most gives away a massing model
 * as a massing model. Windows also give the eye a height reference, which is
 * what makes a 19 m building actually read as 19 m rather than as a big shed.
 */

import * as THREE from "three";

/** Real-world size of one tile: a single window bay, one storey tall. The
 * storey height matches `BUILDING_LEVEL_HEIGHT_M` in the backend config, so
 * buildings whose height came from `building:levels` land a whole number of
 * window rows. */
export const BAY_WIDTH_M = 3.5;
export const STOREY_HEIGHT_M = 3.2;

const TEXTURE_PX = 256;

/** Real-world depth of the deepest feature (the window reveal), in metres —
 * what "0" (fully black) means on the height canvas below. Sets the overall
 * scale the derived normal map's bumps read at; everything else (sill
 * projection, frame thickness) is defined relative to this same range. */
const RELIEF_M = 0.05;

interface Geometry {
  windowWidth: number;
  windowHeight: number;
  left: number;
  top: number;
  storeyBandPx: number;
  mullionWidthPx: number;
  sillHeightPx: number;
}

function px(metres: number, span: number): number {
  return (metres / span) * TEXTURE_PX;
}

function geometry(): Geometry {
  const windowWidth = px(1.25, BAY_WIDTH_M);
  const windowHeight = px(1.55, STOREY_HEIGHT_M);
  return {
    windowWidth,
    windowHeight,
    left: (TEXTURE_PX - windowWidth) / 2,
    // Sits in the upper part of the storey, with a sill below it.
    top: px(0.75, STOREY_HEIGHT_M),
    storeyBandPx: Math.max(1, px(0.12, STOREY_HEIGHT_M)),
    mullionWidthPx: Math.max(1, px(0.05, BAY_WIDTH_M)),
    sillHeightPx: Math.max(1, px(0.09, STOREY_HEIGHT_M)),
  };
}

let facadeTexture: THREE.Texture | null = null;
let facadeNormal: THREE.Texture | null = null;
let facadeRoughness: THREE.Texture | null = null;
let facadeEmissive: THREE.Texture | null = null;

/** Base is left white so the per-building tint in `MaterialLibrary.facade`
 * fully controls the plaster colour; only the window and its frame are drawn
 * with their own values. */
export function facadePatternTexture(): THREE.Texture {
  if (facadeTexture) return facadeTexture;

  const g = geometry();
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_PX;
  canvas.height = TEXTURE_PX;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, TEXTURE_PX, TEXTURE_PX);

  // Storey band: a slightly darker line where floors meet, which reads as the
  // shadow under a string course.
  ctx.fillStyle = "rgba(0, 0, 0, 0.10)";
  ctx.fillRect(0, 0, TEXTURE_PX, g.storeyBandPx);

  // Reveal: the wall thickness around the opening, darker on the top and left
  // where a high sun would throw it into shadow.
  ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
  ctx.fillRect(g.left - 3, g.top - 3, g.windowWidth + 6, g.windowHeight + 6);

  // Glass. Cool and dark: a window seen from outside is mostly a dark room
  // with a bit of sky in it, and reading blue is what stops it looking like a
  // painted-on rectangle.
  const glass = ctx.createLinearGradient(g.left, g.top, g.left, g.top + g.windowHeight);
  glass.addColorStop(0, "#5b6b7d");
  glass.addColorStop(0.55, "#3d4a58");
  glass.addColorStop(1, "#4a5866");
  ctx.fillStyle = glass;
  ctx.fillRect(g.left, g.top, g.windowWidth, g.windowHeight);

  // Frame: one vertical mullion and one horizontal transom.
  ctx.strokeStyle = "rgba(245, 245, 240, 0.85)";
  ctx.lineWidth = g.mullionWidthPx;
  ctx.beginPath();
  ctx.moveTo(g.left + g.windowWidth / 2, g.top);
  ctx.lineTo(g.left + g.windowWidth / 2, g.top + g.windowHeight);
  ctx.moveTo(g.left, g.top + g.windowHeight * 0.45);
  ctx.lineTo(g.left + g.windowWidth, g.top + g.windowHeight * 0.45);
  ctx.strokeRect(g.left, g.top, g.windowWidth, g.windowHeight);
  ctx.stroke();

  // Sill.
  ctx.fillStyle = "rgba(0, 0, 0, 0.16)";
  ctx.fillRect(g.left - 5, g.top + g.windowHeight + 2, g.windowWidth + 10, g.sillHeightPx);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / BAY_WIDTH_M, 1 / STOREY_HEIGHT_M);
  texture.anisotropy = 8;

  facadeTexture = texture;
  return texture;
}

/** Height canvas matching `facadePatternTexture`'s geometry: mid-grey (0.5)
 * is the flat wall plane, darker is recessed (the window reveal, the storey
 * shadow line), lighter is proud of the wall (frame, sill). Drawn separately
 * from the colour texture — window glass, for instance, is dark in colour
 * but sits behind the wall plane, which a colour-derived height map would get
 * backwards. */
function drawHeightField(ctx: CanvasRenderingContext2D, g: Geometry): void {
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, TEXTURE_PX, TEXTURE_PX);

  ctx.fillStyle = "#707070"; // shallow shadow line, not a real recess
  ctx.fillRect(0, 0, TEXTURE_PX, g.storeyBandPx);

  ctx.fillStyle = "#000000"; // the reveal itself: the full RELIEF_M depth
  ctx.fillRect(g.left - 3, g.top - 3, g.windowWidth + 6, g.windowHeight + 6);

  ctx.fillStyle = "#303030"; // glass sits a little proud of the reveal's floor
  ctx.fillRect(g.left, g.top, g.windowWidth, g.windowHeight);

  ctx.strokeStyle = "#c8c8c8"; // frame stands proud of the wall
  ctx.lineWidth = g.mullionWidthPx;
  ctx.beginPath();
  ctx.moveTo(g.left + g.windowWidth / 2, g.top);
  ctx.lineTo(g.left + g.windowWidth / 2, g.top + g.windowHeight);
  ctx.moveTo(g.left, g.top + g.windowHeight * 0.45);
  ctx.lineTo(g.left + g.windowWidth, g.top + g.windowHeight * 0.45);
  ctx.strokeRect(g.left, g.top, g.windowWidth, g.windowHeight);
  ctx.stroke();

  ctx.fillStyle = "#e6e6e6"; // sill projects furthest of anything
  ctx.fillRect(g.left - 5, g.top + g.windowHeight + 2, g.windowWidth + 10, g.sillHeightPx);
}

/** Derives a tangent-space normal map from `drawHeightField` via a central-
 * difference gradient, the same technique `scripts/generate-ground-detail-maps.mjs`
 * uses for the photographed ground textures — kept as a second implementation
 * rather than shared code since one runs in Node against a decoded JPEG and
 * this one runs against a live canvas, but the maths matches. */
export function facadeNormalTexture(): THREE.Texture {
  if (facadeNormal) return facadeNormal;

  const heightCanvas = document.createElement("canvas");
  heightCanvas.width = TEXTURE_PX;
  heightCanvas.height = TEXTURE_PX;
  drawHeightField(heightCanvas.getContext("2d")!, geometry());
  const texture = normalMapOf(heightCanvas, BAY_WIDTH_M, STOREY_HEIGHT_M, RELIEF_M, true);
  texture.repeat.set(1 / BAY_WIDTH_M, 1 / STOREY_HEIGHT_M);

  facadeNormal = texture;
  return texture;
}

/** The normal map of a height canvas (mid-grey the wall's plane, black
 * `reliefM` behind it) spanning `widthM` by `heightM`; repeating across, and
 * up too if `wrapY`. */
function normalMapOf(heightCanvas: HTMLCanvasElement, widthM: number, heightM: number, reliefM: number, wrapY: boolean): THREE.Texture {
  const w = heightCanvas.width;
  const h = heightCanvas.height;
  const heightData = heightCanvas.getContext("2d")!.getImageData(0, 0, w, h).data;
  const heightAt = (x: number, y: number) => heightData[(y * w + x) * 4] / 255;
  const row = (y: number) => (wrapY ? (y + h) % h : Math.min(h - 1, Math.max(0, y)));

  const texelWorldXM = widthM / w;
  const texelWorldYM = heightM / h;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(w, h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xL = heightAt((x - 1 + w) % w, y);
      const xR = heightAt((x + 1) % w, y);
      const yU = heightAt(x, row(y - 1));
      const yD = heightAt(x, row(y + 1));

      const dHdx = ((xR - xL) * reliefM) / (2 * texelWorldXM);
      const dHdy = ((yD - yU) * reliefM) / (2 * texelWorldYM);

      let nx = -dHdx;
      let ny = -dHdy;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;

      const idx = (y * w + x) * 4;
      image.data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      image.data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      image.data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      image.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  // Data, not colour — must stay linear or the sRGB decode meant for photos
  // skews every sampled normal.
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = wrapY ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** Roughness multiplier: near-mirror glass against a matte plaster/frame
 * wall. Without this the `facade()` material's single roughness value (tuned
 * for plaster) makes windows look like painted rectangles instead of glazing. */
export function facadeRoughnessTexture(): THREE.Texture {
  if (facadeRoughness) return facadeRoughness;

  const g = geometry();
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_PX;
  canvas.height = TEXTURE_PX;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#e6e6e6"; // ~0.9x multiplier: plaster, frame, sill
  ctx.fillRect(0, 0, TEXTURE_PX, TEXTURE_PX);

  ctx.fillStyle = "#262626"; // ~0.15x multiplier: glass
  ctx.fillRect(g.left, g.top, g.windowWidth, g.windowHeight);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / BAY_WIDTH_M, 1 / STOREY_HEIGHT_M);

  facadeRoughness = texture;
  return texture;
}

// How many bays/storeys of variation repeat before the lit-window pattern
// itself repeats. `facadePatternTexture` et al. tile every single bay (so
// every window is structurally identical, which is fine — real windows
// mostly are); this has to tile much less often, or "night" would mean
// either every window on a building glowing at once or none of them, both
// of which read as an obviously fake, uniform building rather than one with
// people in some rooms and not others.
const WINDOW_GRID_N = 5;
const WINDOW_GRID_PX = 64; // per cell — this only needs to read as a soft glow, not sharp detail
const LIT_FRACTION = 0.3;

/** Grayscale mask (white = lit, black = dark) for `MeshStandardMaterial.
 * emissiveMap` — `MaterialLibrary.facade` supplies the actual glow colour
 * via `emissive`/`emissiveIntensity`, toggled by altitude at night (see
 * `applyNightWindows`), so this only has to say *which* windows, not *how
 * bright*. Reuses `geometry()`'s exact glass-rect placement (scaled down to
 * `WINDOW_GRID_PX`) so a lit cell's glow lines up with the real window drawn
 * by `facadePatternTexture`, just repeated at a coarser period (see
 * `WINDOW_GRID_N`) than that texture's own single-bay tile. */
export function facadeEmissiveTexture(): THREE.Texture {
  if (facadeEmissive) return facadeEmissive;

  const g = geometry();
  const scale = WINDOW_GRID_PX / TEXTURE_PX;
  const size = WINDOW_GRID_PX * WINDOW_GRID_N;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = "#ffffff";
  for (let row = 0; row < WINDOW_GRID_N; row++) {
    for (let col = 0; col < WINDOW_GRID_N; col++) {
      if (Math.random() >= LIT_FRACTION) continue;
      const originX = col * WINDOW_GRID_PX;
      const originY = row * WINDOW_GRID_PX;
      ctx.fillRect(originX + g.left * scale, originY + g.top * scale, g.windowWidth * scale, g.windowHeight * scale);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / (WINDOW_GRID_N * BAY_WIDTH_M), 1 / (WINDOW_GRID_N * STOREY_HEIGHT_M));

  facadeEmissive = texture;
  return texture;
}

// A barn of the Alps (a "tabià"): a ground floor of stone, with a small
// window and a door, and above it walls of vertical larch boards. One tile
// is a stretch of wall from the ground up; the boards run on past its top
// (the texture clamps there, and boards are the same all the way up), so a
// gable's peak is boards too.
const WOOD_TILE_WIDTH_M = 8;
const WOOD_TILE_HEIGHT_M = 6.4;
const WOOD_PX_X = 512;
const WOOD_PX_Y = 512;
const STONE_HEIGHT_M = 2.4;
const BEAM_HEIGHT_M = 0.2;
const WOOD_RELIEF_M = 0.04;

let woodTexture: THREE.Texture | null = null;

/** A wall's v is 1 − its height above the building's base, in metres
 * (three's ExtrudeGeometry; the gables' too, see roofs.ts): turned back
 * into the height, so the tile stands on the ground. */
function fromTheGround(texture: THREE.Texture): void {
  texture.repeat.set(1 / WOOD_TILE_WIDTH_M, -1 / WOOD_TILE_HEIGHT_M);
  texture.offset.set(0, 1 / WOOD_TILE_HEIGHT_M);
}
let woodNormal: THREE.Texture | null = null;

/** The tile's parts, in canvas pixels (y down from the tile's top; the
 * ground is at the bottom). Seeded, so the colour and the relief agree. */
interface WoodLayout {
  stoneTop: number;
  beamTop: number;
  stones: { x: number; y: number; w: number; h: number; shade: number }[];
  boards: { x: number; w: number; shade: number }[];
  window: { x: number; y: number; w: number; h: number };
  door: { x: number; y: number; w: number; h: number };
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let woodLayoutCache: WoodLayout | null = null;

function woodLayout(): WoodLayout {
  if (woodLayoutCache) return woodLayoutCache;
  const random = mulberry32(7);
  const pxX = WOOD_PX_X / WOOD_TILE_WIDTH_M;
  const pxY = WOOD_PX_Y / WOOD_TILE_HEIGHT_M;
  const stoneTop = WOOD_PX_Y - STONE_HEIGHT_M * pxY;
  const beamTop = stoneTop - BEAM_HEIGHT_M * pxY;

  const stones: WoodLayout["stones"] = [];
  for (let y = WOOD_PX_Y; y > stoneTop; ) {
    const h = Math.min((0.22 + random() * 0.18) * pxY, y - stoneTop);
    // Each course starts somewhere else, and wraps around the tile's sides.
    const start = -random() * 0.5 * pxX;
    for (let x = start; x < WOOD_PX_X + start; ) {
      const w = Math.min((0.3 + random() * 0.45) * pxX, WOOD_PX_X + start - x);
      stones.push({ x, y: y - h, w, h, shade: random() });
      x += w;
    }
    y -= h;
  }

  const boards: WoodLayout["boards"] = [];
  for (let x = 0; x < WOOD_PX_X; ) {
    // The last board ends at the tile's edge, so the tiles join.
    const w = Math.min((0.16 + random() * 0.1) * pxX, WOOD_PX_X - x);
    boards.push({ x, w, shade: random() });
    x += w;
  }

  woodLayoutCache = {
    stoneTop,
    beamTop,
    stones,
    boards,
    window: { x: 1.5 * pxX, y: WOOD_PX_Y - 1.8 * pxY, w: 0.6 * pxX, h: 0.6 * pxY },
    door: { x: 5 * pxX, y: WOOD_PX_Y - 1.9 * pxY, w: 1.1 * pxX, h: 1.9 * pxY },
  };
  return woodLayoutCache;
}

/** In the wood's and the stone's own colours (the material's tint only
 * shades them, see `MaterialLibrary.facade`). */
export function woodFacadeTexture(): THREE.Texture {
  if (woodTexture) return woodTexture;
  const l = woodLayout();
  const canvas = document.createElement("canvas");
  canvas.width = WOOD_PX_X;
  canvas.height = WOOD_PX_Y;
  const ctx = canvas.getContext("2d")!;

  // Boards: larch, darkened by the sun, each a little different, the gaps
  // between them dark.
  for (const b of l.boards) {
    const light = 26 + b.shade * 9;
    ctx.fillStyle = `hsl(26, 24%, ${light}%)`;
    ctx.fillRect(b.x, 0, b.w, l.beamTop);
    ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
    for (let k = 1; k < 4; k++) ctx.fillRect(b.x + (b.w * k) / 4 + (b.shade - 0.5) * 3, 0, 1, l.beamTop);
    ctx.fillStyle = "#1c1510";
    ctx.fillRect(b.x, 0, 1.5, l.beamTop);
  }

  // The beam the boards stand on.
  ctx.fillStyle = "#3e2f23";
  ctx.fillRect(0, l.beamTop, WOOD_PX_X, l.stoneTop - l.beamTop);

  // Stone, rendered with lime, the mortar lighter than the stones.
  ctx.fillStyle = "#b9b2a5";
  ctx.fillRect(0, l.stoneTop, WOOD_PX_X, WOOD_PX_Y - l.stoneTop);
  for (const s of l.stones) {
    ctx.fillStyle = `hsl(35, 8%, ${52 + s.shade * 16}%)`;
    for (const dx of [0, WOOD_PX_X]) ctx.fillRect(s.x + dx + 1.5, s.y + 1.5, s.w - 3, s.h - 3);
  }

  // A small window, and a door of darker boards.
  const { window: win, door } = l;
  ctx.fillStyle = "#4a3828";
  ctx.fillRect(win.x - 4, win.y - 4, win.w + 8, win.h + 8);
  ctx.fillStyle = "#1d1a17";
  ctx.fillRect(win.x, win.y, win.w, win.h);
  ctx.fillStyle = "#33261b";
  ctx.fillRect(door.x, door.y, door.w, door.h);
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  for (let k = 1; k < 5; k++) ctx.fillRect(door.x + (door.w * k) / 5, door.y, 1.5, door.h);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  fromTheGround(texture);
  texture.anisotropy = 8;
  woodTexture = texture;
  return texture;
}

export function woodFacadeNormalTexture(): THREE.Texture {
  if (woodNormal) return woodNormal;
  const l = woodLayout();
  const canvas = document.createElement("canvas");
  canvas.width = WOOD_PX_X;
  canvas.height = WOOD_PX_Y;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, WOOD_PX_X, WOOD_PX_Y);
  ctx.fillStyle = "#202020"; // the gaps between the boards
  for (const b of l.boards) ctx.fillRect(b.x, 0, 1.5, l.beamTop);
  ctx.fillStyle = "#b0b0b0"; // the beam stands out
  ctx.fillRect(0, l.beamTop, WOOD_PX_X, l.stoneTop - l.beamTop);
  ctx.fillStyle = "#505050"; // mortar, behind the stones' faces
  ctx.fillRect(0, l.stoneTop, WOOD_PX_X, WOOD_PX_Y - l.stoneTop);
  for (const s of l.stones) {
    const v = Math.round(128 + s.shade * 40);
    ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
    for (const dx of [0, WOOD_PX_X]) ctx.fillRect(s.x + dx + 1.5, s.y + 1.5, s.w - 3, s.h - 3);
  }
  ctx.fillStyle = "#000000"; // the window's recess
  ctx.fillRect(l.window.x, l.window.y, l.window.w, l.window.h);
  ctx.fillStyle = "#606060"; // the door, set back a little
  ctx.fillRect(l.door.x, l.door.y, l.door.w, l.door.h);

  const texture = normalMapOf(canvas, WOOD_TILE_WIDTH_M, WOOD_TILE_HEIGHT_M, WOOD_RELIEF_M, false);
  fromTheGround(texture);
  woodNormal = texture;
  return texture;
}
