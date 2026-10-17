/** Rasterizes `cardIconShapes.ts`'s shared shape data for use as MapLibre
 * marker icons — same shapes as the UI's `CardIcon`, drawn with Canvas2D
 * instead of SVG since `map.addImage` needs raster data. Drawn in plain
 * white: markers are tinted per-category via `fill-color` already, and a
 * single white icon reads cleanly against any of the four category colors,
 * so there's no need to pre-render a colored variant per category.
 */

import type { CardType } from "../api/types";
import { CARD_ICON_SHAPES } from "../ui/cardIconShapes";

/** Canvas size in px. The shapes are on a 24x24 grid; the margin keeps
 * 1.6px-wide strokes near the edge (e.g. the tree canopy circle) from being
 * clipped by the canvas bounds. */
const ICON_PX = 32;
const MARGIN_PX = 4;
const VIEWBOX = 24;

export const ALL_CARD_TYPES: CardType[] = [
  "plant_tree",
  "plant_grove",
  "new_path",
  "change_ground_cover",
  "add_streetlight",
  "add_bench",
  "add_pergola",
  "add_kiosk",
  "add_playground",
  "add_fitness_area",
  "add_streetlight_path",
  "plant_tree_row",
];

export function buildCardMarkerImage(cardType: CardType): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = ICON_PX;
  canvas.height = ICON_PX;
  const ctx = canvas.getContext("2d")!;
  drawCardIcon(ctx, cardType, "#ffffff", MARGIN_PX, MARGIN_PX, ICON_PX - MARGIN_PX * 2);
  return ctx.getImageData(0, 0, ICON_PX, ICON_PX);
}

/** Strokes a card's icon into a `sizePx` square at (x, y) — shared with the
 * 3D view's standing placards (`three/builders/placards.ts`). */
export function drawCardIcon(
  ctx: CanvasRenderingContext2D,
  cardType: CardType,
  color: string,
  x: number,
  y: number,
  sizePx: number
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(sizePx / VIEWBOX, sizePx / VIEWBOX);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const shape of CARD_ICON_SHAPES[cardType]) {
    ctx.setLineDash(shape.kind !== "circle" && shape.kind !== "rect" && shape.dash ? shape.dash : []);
    if (shape.kind === "path") {
      ctx.stroke(new Path2D(shape.d));
      continue;
    }
    ctx.beginPath();
    if (shape.kind === "line") {
      ctx.moveTo(shape.x1, shape.y1);
      ctx.lineTo(shape.x2, shape.y2);
    } else if (shape.kind === "circle") {
      ctx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
    } else if (shape.kind === "rect") {
      if (shape.rx) ctx.roundRect(shape.x, shape.y, shape.w, shape.h, shape.rx);
      else ctx.rect(shape.x, shape.y, shape.w, shape.h);
    }
    ctx.stroke();
  }
  ctx.restore();
}
