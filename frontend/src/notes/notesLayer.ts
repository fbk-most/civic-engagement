/** The notes on the 2D map: a MapLibre layer (not HTML markers, so that
 * they're in the map's own picture), each note a speech bubble with its
 * title (notes/bubble.ts) over a dot at its point. */

import type { ExpressionSpecification, GeoJSONSource, MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { drawBubble } from "./bubble";
import { DRAFT, type Bubble } from "./bubbles";
import { noteWords } from "./words";

const SOURCE = "notes";
/** The bubbles: what a click picks. */
export const NOTES_LAYER = "notes-bubbles";
const POINTS_LAYER = "notes-points";
/** The scene's first layer (map/layers.ts): the notes go over the scene. */
const SCENE_LAYER = "covers-fill";
/** Device pixels per CSS pixel the bubbles are drawn at: sharp on a dense screen. */
const PIXEL_RATIO = 2;

// The bubble images each map holds, by name, to drop those no longer used.
const images = new WeakMap<MapLibreMap, Set<string>>();

// A note being added or moved: the next click on the map is its point
// (or, while its words are written, nobody's), and nothing else may take
// it (App's own click handlers ask `notesClaimClick`).
let armed = false;

export function setNotesArmed(value: boolean): void {
  armed = value;
}

/** Whether a click on the map is the notes': one is being placed, or a
 * bubble is under it. */
export function notesClaimClick(map: MapLibreMap, event: MapMouseEvent): boolean {
  if (armed) return true;
  return !!map.getLayer(NOTES_LAYER) && map.queryRenderedFeatures(event.point, { layers: [NOTES_LAYER] }).length > 0;
}

/** Draws these bubbles (none: hides them; see notes/bubbles.ts). False
 * if the scene's layers aren't there yet: nothing drawn. */
export function setNotesLayer(map: MapLibreMap, bubbles: Bubble[]): boolean {
  if (!map.getLayer(SCENE_LAYER)) return false;
  const { color } = noteWords();
  const held = images.get(map) ?? new Set<string>();
  images.set(map, held);
  const used = new Set<string>();
  const features: GeoJSON.Feature[] = bubbles.map((bubble) => {
    const image = `note:${bubble.selected ? "selected" : "plain"}:${color}:${bubble.title}`;
    if (!map.hasImage(image)) {
      const canvas = drawBubble(bubble.title, color, PIXEL_RATIO, bubble.selected);
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
      map.addImage(image, data, { pixelRatio: PIXEL_RATIO });
    }
    held.add(image);
    used.add(image);
    // The one being added isn't a note yet: nothing to open.
    const noteId = bubble.id === DRAFT ? null : bubble.id;
    return { type: "Feature", geometry: bubble.point, properties: { noteId, image, moving: bubble.moving } };
  });
  for (const image of [...held]) {
    if (used.has(image)) continue;
    if (map.hasImage(image)) map.removeImage(image);
    held.delete(image);
  }

  const data: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };
  const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
  if (source) source.setData(data);
  else map.addSource(SOURCE, { type: "geojson", data });
  // The note being moved, faded.
  const faded = (): ExpressionSpecification => ["case", ["boolean", ["get", "moving"], false], 0.4, 1];
  if (!map.getLayer(POINTS_LAYER)) {
    map.addLayer({
      id: POINTS_LAYER,
      type: "circle",
      source: SOURCE,
      paint: {
        "circle-radius": 3.5,
        "circle-color": color,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
        "circle-opacity": faded(),
        "circle-stroke-opacity": faded(),
      },
    });
  }
  if (!map.getLayer(NOTES_LAYER)) {
    map.addLayer({
      id: NOTES_LAYER,
      type: "symbol",
      source: SOURCE,
      layout: {
        "icon-image": ["get", "image"],
        "icon-anchor": "bottom",
        "icon-offset": [0, -3],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "symbol-z-order": "source",
      },
      paint: { "icon-opacity": faded() },
    });
  }
  return true;
}
