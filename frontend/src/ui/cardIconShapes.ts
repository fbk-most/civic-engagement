import { activePack } from "../pack";

/** Shared geometric description of each card's icon, on a 24x24 grid — the
 * single source of truth for both the SVG icon shown in the UI
 * (`cardIcons.tsx`) and the raster icon drawn onto the map's "Carte
 * proposte" markers (`map/cardMarkerIcons.ts`). Keeping one description
 * avoids the two ever drifting apart. The shapes are the pack's
 * (`FrontendPack.cardIcons`). */
export type IconShape =
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; dash?: [number, number] }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "rect"; x: number; y: number; w: number; h: number; rx?: number }
  | { kind: "path"; d: string; dash?: [number, number] };

/** A card's icon; none (an empty icon) if the pack has none for it. */
export function cardIconShapes(cardType: string): IconShape[] {
  return activePack().cardIcons[cardType] ?? [];
}
