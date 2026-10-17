import type { CSSProperties } from "react";
import type { MapElementLayer } from "./map/layers";
import type { Surface } from "./three/materials";
import type { PartBuilder } from "./three/parts";
import type { IconShape } from "./ui/cardIconShapes";

/** The frontend side of a domain pack (see civic_engagement/domain.py for
 * the backend's): what the core's interface needs from the domain. Each
 * pack's app passes its own to `startApp`, which registers it before
 * anything renders; modules outside React read it with `activePack()`. */
export interface FrontendPack {
  id: string;
  /** The app's name, e.g. in the window title. */
  title: string;
  /** The cards' categories, in the card palette's order. The colour is the
   * category's identity across the palette, the placed-intervention list,
   * the map markers and the 3D placards. */
  cardCategories: { id: string; label: Pair; color: string }[];
  /** Each card's icon, on a 24x24 grid (see ui/cardIconShapes.ts). */
  cardIcons: Record<string, IconShape[]>;
  /** The cover types' names and colours (on the map, and in the space use
   * chart, which stacks them in this order). */
  coverTypes: Record<string, { label: Pair; color: string }>;
  labels: {
    /** The values of the cards' select parameters, by parameter key. */
    options: Record<string, Record<string, Pair>>;
    /** Tree species and age classes, for the tree identity card. */
    species: Record<string, Pair>;
    ageClasses: Record<string, Pair>;
  };
  map: {
    /** The elements' layers on the 2D map, in drawing order, above the
     * covers and below the intervention markers (see map/layers.ts). */
    layers: MapElementLayer[];
    legend: { label: Pair; swatch: CSSProperties }[];
  };
  scene3d: {
    /** How each cover type and path material looks (see three/materials.ts);
     * a default paving otherwise. */
    coverSurfaces: Record<string, Surface>;
    pathSurfaces: Record<string, Surface>;
    /** Element types drawn as flat ribbons along their lines, by their
     * `width` and `material` (see three/builders/paths.ts). */
    ribbonTypes: string[];
    /** Cover types drawn as animated water rather than flat ground. */
    waterCoverTypes: string[];
    /** The pack's own parts of the scene, built after the core's ground,
     * ribbons, buildings and trees, before the water. */
    parts: PartBuilder[];
  };
}

/** A text in Italian and English (see i18n/lang.ts's `tr`). */
export type Pair = [it: string, en: string];

let pack: FrontendPack | null = null;

export function registerPack(next: FrontendPack): void {
  if (pack !== null && pack !== next) throw new Error(`A frontend pack (${pack.id}) is already registered`);
  pack = next;
}

export function activePack(): FrontendPack {
  if (pack === null) throw new Error("No frontend pack registered: start the app with startApp(pack)");
  return pack;
}
