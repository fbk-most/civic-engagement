import type { CardCategory } from "../api/types";

// Colors double as the category's visual identity across the palette, the
// placed-intervention list and the map legend — keep them in one place.
export const CATEGORY_COLORS: Record<CardCategory, string> = {
  vegetazione: "#2e6b1f",
  copertura_suolo: "#8a6d3b",
  elementi_architettonici: "#5b6472",
  sociale: "#c9752f",
};
