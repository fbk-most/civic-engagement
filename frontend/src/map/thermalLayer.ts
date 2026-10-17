/** The felt-temperature field on the 2D map: one semi-transparent image
 * draped on the ground, under buildings, trees and furniture, redrawn when
 * the field or the hour changes. */

import type { ImageSource, Map as MapLibreMap } from "maplibre-gl";
import { toLngLat, type GeoAnchor } from "../three/geo";
import { layerToRgba, STALE_DIMMING, type ThermalField } from "../thermal/field";

const SOURCE = "thermal-field";
const LAYER = "thermal-field-raster";
// Drawn just under the extruded buildings: over ground covers, streets and
// paths, under everything standing on them.
const BEFORE_LAYER = "buildings-extrusion";
export const THERMAL_OPACITY = 0.5;
// While the field is shown the ground covers underneath are faded, or their
// colours (green lawn, blue water) mix with the field's into other ones.
const COVERS_LAYER = "covers-fill";
const COVERS_FADED_OPACITY = 0.25;

function fadeCovers(map: MapLibreMap, faded: boolean): void {
  if (map.getLayer(COVERS_LAYER)) map.setPaintProperty(COVERS_LAYER, "fill-opacity", faded ? COVERS_FADED_OPACITY : 1);
}

let canvas: HTMLCanvasElement | null = null;

function imageUrl(field: ThermalField, layer: Float32Array): string {
  const { nx, ny } = field.grid;
  canvas ??= document.createElement("canvas");
  canvas.width = nx;
  canvas.height = ny;
  const context = canvas.getContext("2d")!;
  context.putImageData(new ImageData(layerToRgba(field, layer), nx, ny), 0, 0);
  return canvas.toDataURL();
}

/** The grid's corners, clockwise from the north-west (MapLibre's order). */
function corners(field: ThermalField, anchor: GeoAnchor): [[number, number], [number, number], [number, number], [number, number]] {
  const { x0, y0, nx, ny, cell_m } = field.grid;
  const east = x0 + nx * cell_m;
  const north = y0 + ny * cell_m;
  // The local frame's z points south.
  return [
    toLngLat(anchor, x0, -north),
    toLngLat(anchor, east, -north),
    toLngLat(anchor, east, -y0),
    toLngLat(anchor, x0, -y0),
  ];
}

/** Shows `layer` (one hour of `field`) on the map, or hides the field when
 * `field` is null; `stale` (another day's field, standing in while the
 * right one loads) dims it. Expects the scene's layers to be in place
 * already. */
export function setThermalLayer(
  map: MapLibreMap,
  anchor: GeoAnchor,
  field: ThermalField | null,
  layer: Float32Array | null,
  stale = false
): void {
  if (!field || !layer) {
    if (map.getLayer(LAYER)) map.setLayoutProperty(LAYER, "visibility", "none");
    fadeCovers(map, false);
    return;
  }
  const url = imageUrl(field, layer);
  const coordinates = corners(field, anchor);
  const source = map.getSource(SOURCE) as ImageSource | undefined;
  if (source) {
    source.updateImage({ url, coordinates });
  } else {
    map.addSource(SOURCE, { type: "image", url, coordinates });
  }
  if (!map.getLayer(LAYER)) {
    map.addLayer(
      {
        id: LAYER,
        type: "raster",
        source: SOURCE,
        paint: { "raster-opacity": THERMAL_OPACITY, "raster-resampling": "linear", "raster-fade-duration": 0 },
      },
      map.getLayer(BEFORE_LAYER) ? BEFORE_LAYER : undefined
    );
  }
  map.setLayoutProperty(LAYER, "visibility", "visible");
  map.setPaintProperty(LAYER, "raster-opacity", THERMAL_OPACITY * (stale ? STALE_DIMMING : 1));
  fadeCovers(map, true);
}
