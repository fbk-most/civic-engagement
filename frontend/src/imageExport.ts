/** "Scarica immagine": the file names and the download, shared by the 2D
 * map and the 3D view. */

/** Lower-case ASCII, words joined by "-": a name safe in a file name on
 * any system ("Tavolo 1" → "tavolo-1", "Più verde!" → "piu-verde"). */
export function fileSlug(text: string): string {
  return (
    text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x"
  );
}

/** `<site>_<team>_<scenario or "corrente">_<year>_<2d|3d>.png`: which
 * table, which proposal, which year, which view, readable in a folder of
 * them after a plenary. */
export function imageFileName(parts: {
  site: string;
  team: string;
  /** The scenario loaded, if the cards are still as loaded; null otherwise. */
  scenario: string | null;
  year: number;
  view: "2d" | "3d";
}): string {
  const scenario = parts.scenario === null ? "corrente" : fileSlug(parts.scenario);
  return `${fileSlug(parts.site)}_${fileSlug(parts.team)}_${scenario}_${parts.year}_${parts.view}.png`;
}

/** Downloads what the canvas holds now: call it right after a render (a
 * WebGL canvas keeps its picture only until the frame ends). The picture
 * is taken when called; the file is written after. */
export function downloadCanvas(canvas: HTMLCanvasElement, fileName: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // After the click has handed the file over.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}

// A's and B's colours, as on screen (App.css, `comparison-picker__letter--*`).
const PAIR_COLORS = { a: "#7b3fa8", b: "#d9730d" } as const;

/** Two scenarios compared as one picture: A and B side by side, a thin gap
 * between, each labelled at its top left with its letter (in its colour)
 * and its name. */
export function pairImage(a: HTMLCanvasElement, b: HTMLCanvasElement, labelA: string, labelB: string): HTMLCanvasElement {
  const scale = Math.max(1, a.height / 600);
  const gap = Math.round(4 * scale);
  const pair = document.createElement("canvas");
  pair.width = a.width + gap + b.width;
  pair.height = Math.max(a.height, b.height);
  const ctx = pair.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pair.width, pair.height);
  const sides: ["a" | "b", HTMLCanvasElement, number, string][] = [
    ["a", a, 0, labelA],
    ["b", b, a.width + gap, labelB],
  ];
  for (const [side, canvas, x, label] of sides) {
    ctx.drawImage(canvas, x, 0);
    const font = Math.round(15 * scale);
    ctx.font = `600 ${font}px sans-serif`;
    const pad = Math.round(8 * scale);
    const radius = font * 0.6;
    const width = pad + radius * 2 + pad / 2 + ctx.measureText(label).width + pad;
    const height = font + pad * 2;
    const left = x + pad;
    const top = pad;
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.fillRect(left, top, width, height);
    ctx.fillStyle = PAIR_COLORS[side];
    ctx.beginPath();
    ctx.arc(left + pad + radius, top + height / 2, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(font * 0.75)}px sans-serif`;
    ctx.fillText(side.toUpperCase(), left + pad + radius, top + height / 2);
    ctx.fillStyle = "#222222";
    ctx.textAlign = "left";
    ctx.font = `600 ${font}px sans-serif`;
    ctx.fillText(label, left + pad + radius * 2 + pad / 2, top + height / 2);
  }
  return pair;
}
