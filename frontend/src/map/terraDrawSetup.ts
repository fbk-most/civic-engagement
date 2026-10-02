import { TerraDraw, TerraDrawPointMode, TerraDrawLineStringMode, TerraDrawPolygonMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import type { MapLibreMap } from "maplibre-gl";
import type { PlacementType } from "../api/types";

export function createDraw(map: MapLibreMap) {
  // Halved from the library default of 40px: that's the click-proximity radius
  // used to detect "clicked near the start/last point → finish the shape", so
  // the default was snapping points into a finish/close even when the
  // facilitator meant to place two vertices close together.
  const pointMode = new TerraDrawPointMode();
  const lineStringMode = new TerraDrawLineStringMode({ pointerDistance: 20 });
  const polygonMode = new TerraDrawPolygonMode({ pointerDistance: 20 });

  const draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map }),
    modes: [pointMode, lineStringMode, polygonMode],
  });

  const modeForPlacement: Partial<Record<PlacementType, string>> = {
    point: pointMode.mode,
    polyline: lineStringMode.mode,
    area: polygonMode.mode,
  };

  return { draw, modeForPlacement };
}
