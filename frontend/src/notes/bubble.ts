/** A note's speech bubble with its title, drawn once for the 2D map's
 * layer (an image per title, map/notesLayer.ts) and for the 3D view's
 * placards (three/builders/notePlacards.ts): no glyphs needed, the map's
 * style has none (it works offline). */

const FONT_PX = 13;
const PAD_X = 8;
const PAD_Y = 5;
const MAX_TEXT_PX = 170;
const TAIL_PX = 8;
const RADIUS_PX = 7;

/** The bubble at `scale` device pixels per CSS pixel: its tail's tip at
 * the bottom middle (where the note is). `selected` draws it outlined. */
export function drawBubble(title: string, color: string, scale: number, selected = false): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const measure = canvas.getContext("2d")!;
  const font = `600 ${FONT_PX}px system-ui, sans-serif`;
  measure.font = font;
  const text = fitted(measure, title, MAX_TEXT_PX);
  const border = selected ? 3 : 1.5;
  const width = Math.ceil(measure.measureText(text).width) + PAD_X * 2 + border * 2;
  const bodyHeight = Math.round(FONT_PX * 1.3) + PAD_Y * 2 + border * 2;
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil((bodyHeight + TAIL_PX) * scale);

  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  const half = border / 2;
  const bottom = bodyHeight - half;
  const middle = width / 2;
  ctx.beginPath();
  ctx.roundRect(half, half, width - border, bodyHeight - border, RADIUS_PX);
  ctx.moveTo(middle - 6, bottom);
  ctx.lineTo(middle, bodyHeight + TAIL_PX - border);
  ctx.lineTo(middle + 6, bottom);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = border;
  ctx.strokeStyle = selected ? "#1d1d1d" : "#ffffff";
  ctx.stroke();
  // The tail's join with the body, under the outline drawn across it.
  ctx.fillRect(middle - 6 + border, bottom - border, 12 - border * 2, border * 2);

  ctx.fillStyle = "#ffffff";
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, middle, bodyHeight / 2);
  return canvas;
}

/** The text, cut with an ellipsis to fit `maxPx`. */
function fitted(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (ctx.measureText(text).width <= maxPx) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxPx) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}
