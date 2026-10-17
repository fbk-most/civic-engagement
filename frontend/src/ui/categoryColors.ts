import { activePack } from "../pack";

/** A card category's colour, the category's visual identity across the
 * palette, the placed-intervention list, the map markers and the 3D
 * placards — the pack's (`FrontendPack.cardCategories`). */
export function categoryColor(category: string, fallback = "#999"): string {
  return activePack().cardCategories.find((c) => c.id === category)?.color ?? fallback;
}
