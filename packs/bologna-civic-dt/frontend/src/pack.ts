import type { FrontendPack } from "civic-engagement";
import { CARD_ICONS } from "./cardIcons";
import { CARD_CATEGORIES, COVER_TYPES, LABELS } from "./labels";
import { MAP } from "./mapLayers";
import { SCENE_3D } from "./scene3d";

/** The urban pack's side of the frontend (see the core's src/pack.ts). */
export const urbanPack: FrontendPack = {
  id: "urban",
  title: "Bologna Civic Digital Twin",
  features: { thermal: true, life: true },
  cardCategories: CARD_CATEGORIES,
  cardIcons: CARD_ICONS,
  coverTypes: COVER_TYPES,
  labels: LABELS,
  map: MAP,
  scene3d: SCENE_3D,
};
