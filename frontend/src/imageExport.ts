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
