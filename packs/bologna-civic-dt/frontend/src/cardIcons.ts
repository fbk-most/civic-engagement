import type { IconShape } from "civic-engagement";

/** Each urban card's icon, on a 24x24 grid (see the core's
 * ui/cardIconShapes.ts). */
export const CARD_ICONS: Record<string, IconShape[]> = {
  plant_tree: [
    { kind: "line", x1: 12, y1: 21, x2: 12, y2: 14 },
    { kind: "circle", cx: 12, cy: 9, r: 6 },
  ],
  plant_grove: [
    { kind: "line", x1: 7, y1: 21, x2: 7, y2: 15 },
    { kind: "circle", cx: 7, cy: 11, r: 4.2 },
    { kind: "line", x1: 17, y1: 21, x2: 17, y2: 16 },
    { kind: "circle", cx: 17, cy: 12, r: 3.6 },
  ],
  new_path: [
    { kind: "path", d: "M4 20c3-4 3-8 0-12s0-6 3-4.5" },
    { kind: "path", d: "M9 21c3-4 3-8 0-12s0-6 3-4.5", dash: [2.2, 2.2] },
  ],
  change_ground_cover: [
    { kind: "rect", x: 3.5, y: 9, w: 17, h: 10, rx: 1.5 },
    { kind: "path", d: "M7 9v-1.5M12 9V6M17 9V7.5" },
  ],
  add_streetlight: [
    { kind: "line", x1: 12, y1: 21, x2: 12, y2: 9 },
    { kind: "circle", cx: 12, cy: 6, r: 2.6 },
    { kind: "line", x1: 7.5, y1: 4.5, x2: 6, y2: 3.2 },
    { kind: "line", x1: 16.5, y1: 4.5, x2: 18, y2: 3.2 },
    { kind: "line", x1: 12, y1: 1.5, x2: 12, y2: 0.2 },
  ],
  add_bench: [
    { kind: "line", x1: 4, y1: 12, x2: 20, y2: 12 },
    { kind: "line", x1: 4, y1: 15.5, x2: 20, y2: 15.5 },
    { kind: "line", x1: 6, y1: 15.5, x2: 6, y2: 20 },
    { kind: "line", x1: 18, y1: 15.5, x2: 18, y2: 20 },
    { kind: "line", x1: 4, y1: 12, x2: 4, y2: 6 },
  ],
  add_pergola: [
    { kind: "rect", x: 4, y: 5, w: 16, h: 4 },
    { kind: "line", x1: 6, y1: 9, x2: 6, y2: 20 },
    { kind: "line", x1: 18, y1: 9, x2: 18, y2: 20 },
    { kind: "line", x1: 9, y1: 5, x2: 9, y2: 9 },
    { kind: "line", x1: 15, y1: 5, x2: 15, y2: 9 },
  ],
  add_kiosk: [
    { kind: "path", d: "M4 10l8-6 8 6" },
    { kind: "rect", x: 5.5, y: 10, w: 13, h: 9 },
    { kind: "line", x1: 9, y1: 19, x2: 9, y2: 14 },
    { kind: "line", x1: 15, y1: 19, x2: 15, y2: 14 },
  ],
  add_playground: [
    { kind: "line", x1: 5, y1: 4, x2: 5, y2: 20 },
    { kind: "line", x1: 19, y1: 4, x2: 19, y2: 20 },
    { kind: "line", x1: 5, y1: 4, x2: 19, y2: 4 },
    { kind: "path", d: "M9 4c0 5 6 5 6 10" },
    { kind: "line", x1: 15, y1: 14, x2: 15, y2: 20 },
  ],
  add_fitness_area: [
    { kind: "line", x1: 2.5, y1: 12, x2: 21.5, y2: 12 },
    { kind: "rect", x: 1.5, y: 9, w: 3, h: 6, rx: 1 },
    { kind: "rect", x: 19.5, y: 9, w: 3, h: 6, rx: 1 },
  ],
  // Three trees along a dashed line.
  plant_tree_row: [
    { kind: "line", x1: 4.5, y1: 19, x2: 4.5, y2: 13 },
    { kind: "circle", cx: 4.5, cy: 9.5, r: 3.2 },
    { kind: "line", x1: 12, y1: 19, x2: 12, y2: 13 },
    { kind: "circle", cx: 12, cy: 9.5, r: 3.2 },
    { kind: "line", x1: 19.5, y1: 19, x2: 19.5, y2: 13 },
    { kind: "circle", cx: 19.5, cy: 9.5, r: 3.2 },
    { kind: "line", x1: 2, y1: 22, x2: 22, y2: 22, dash: [2.2, 2.2] },
  ],
  // Two lamps along a dashed path.
  add_streetlight_path: [
    { kind: "line", x1: 6, y1: 19, x2: 6, y2: 8 },
    { kind: "circle", cx: 6, cy: 5.5, r: 2.3 },
    { kind: "line", x1: 18, y1: 19, x2: 18, y2: 8 },
    { kind: "circle", cx: 18, cy: 5.5, r: 2.3 },
    { kind: "line", x1: 2, y1: 22, x2: 22, y2: 22, dash: [2.2, 2.2] },
  ],
};
