import { useCallback, useEffect, useRef, useState } from "react";
import type { MapLibreMap } from "maplibre-gl";
import type { CardSpec, IndicatorDescriptors, InterventionDisplayMode } from "../api/types";
import { SIDES, type ComparedSource, type Side } from "../comparison";
import { downloadCanvas, pairImage } from "../imageExport";
import { tr } from "../i18n/lang";
import { readMapFraming, type MapFraming } from "../map/viewSync";
import { PaneMap, ScenarioPane } from "./ScenarioPane";

interface Props {
  comparison: Record<Side, ComparedSource>;
  t: number;
  mode: InterventionDisplayMode;
  cards: CardSpec[];
  descriptors: IndicatorDescriptors | null;
  showKpi: boolean;
  /** The main map's framing: the panes open on it. */
  initialFraming: MapFraming | null;
  /** Where the panes were last, when the view goes: for the main map. */
  onLeave: (framing: MapFraming) => void;
  /** The pair's image file name; no button without it (no `export`). */
  imageName?: () => string;
}

/** The 2D tab of a comparison: A and B side by side, read-only, their
 * cameras moved together. */
export function ComparisonView({ comparison, t, mode, cards, descriptors, showKpi, initialFraming, onLeave, imageName }: Props) {
  const [maps, setMaps] = useState<Record<Side, MapLibreMap | null>>({ a: null, b: null });
  const onMap = useCallback((side: Side, map: MapLibreMap | null) => setMaps((now) => ({ ...now, [side]: map })), []);
  const lastFramingRef = useRef(initialFraming);
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;
  useEffect(
    () => () => {
      if (lastFramingRef.current) onLeaveRef.current(lastFramingRef.current);
    },
    []
  );

  // The cameras together: the map last pressed, scrolled or typed on leads
  // (its moves are the user's, inertia included), the other follows it.
  useEffect(() => {
    const { a, b } = maps;
    if (!a || !b) return;
    let leader: MapLibreMap | null = null;
    const pairs: [MapLibreMap, MapLibreMap][] = [
      [a, b],
      [b, a],
    ];
    const off: (() => void)[] = [];
    for (const [map, other] of pairs) {
      const lead = () => {
        leader = map;
      };
      const move = () => {
        if (leader === map) other.jumpTo(readMapFraming(map));
      };
      const end = () => {
        if (leader === map) lastFramingRef.current = readMapFraming(map);
      };
      const container = map.getContainer();
      const inputs = ["pointerdown", "wheel", "touchstart", "keydown"] as const;
      for (const input of inputs) container.addEventListener(input, lead, { capture: true, passive: true });
      map.on("move", move);
      map.on("moveend", end);
      off.push(() => {
        for (const input of inputs) container.removeEventListener(input, lead, { capture: true });
        map.off("move", move);
        map.off("moveend", end);
      });
    }
    // Both where A is (B may have come in later, framed on its own).
    b.jumpTo(readMapFraming(a));
    return () => off.forEach((f) => f());
  }, [maps]);

  /** Both maps as one picture, A on the left, each with its name. */
  function downloadPair() {
    const { a, b } = maps;
    if (!a || !b || !imageName) return;
    const name = imageName();
    const copies: Partial<Record<Side, HTMLCanvasElement>> = {};
    for (const side of SIDES) {
      const map = maps[side]!;
      // MapLibre clears its buffer after each frame: copied in the next one.
      map.once("render", () => {
        const source = map.getCanvas();
        const copy = document.createElement("canvas");
        copy.width = source.width;
        copy.height = source.height;
        copy.getContext("2d")!.drawImage(source, 0, 0);
        copies[side] = copy;
        if (copies.a && copies.b) {
          downloadCanvas(pairImage(copies.a, copies.b, comparison.a.label, comparison.b.label), name);
        }
      });
      map.triggerRepaint();
    }
  }

  return (
    <div className="comparison-view">
      {SIDES.map((side) => (
        <ScenarioPane key={side} side={side} source={comparison[side]} t={t} mode={mode} descriptors={descriptors} showKpi={showKpi}>
          {(scene) => <PaneMap side={side} scene={scene} mode={mode} cards={cards} initialFraming={initialFraming} onMap={onMap} />}
        </ScenarioPane>
      ))}
      {imageName && (
        <button
          type="button"
          className="map-download"
          onClick={downloadPair}
          disabled={!maps.a || !maps.b}
          title={tr("Scarica i due scenari affiancati come un'immagine", "Download the two scenarios side by side as an image")}
        >
          {tr("Scarica immagine", "Download image")}
        </button>
      )}
    </div>
  );
}
