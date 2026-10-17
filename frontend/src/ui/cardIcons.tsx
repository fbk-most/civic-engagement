import { cardIconShapes, type IconShape } from "./cardIconShapes";

/** Renders `cardIconShapes.ts`'s shared shape data as an SVG, 24x24, stroked
 * in `currentColor` so the category color (set via CSS) tints it for free.
 * No icon library dependency — consistent with the offline-first stance
 * already taken for the 3D assets. The same shape data also backs the
 * raster icons drawn onto the map's markers (`map/cardMarkerIcons.ts`). */

interface Props {
  cardType: string;
  className?: string;
}

function renderShape(shape: IconShape, key: number) {
  switch (shape.kind) {
    case "line":
      return (
        <line
          key={key}
          x1={shape.x1}
          y1={shape.y1}
          x2={shape.x2}
          y2={shape.y2}
          strokeDasharray={shape.dash?.join(" ")}
        />
      );
    case "circle":
      return <circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} />;
    case "rect":
      return <rect key={key} x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={shape.rx} />;
    case "path":
      return <path key={key} d={shape.d} strokeDasharray={shape.dash?.join(" ")} />;
  }
}

export function CardIcon({ cardType, className }: Props) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {cardIconShapes(cardType).map((shape, i) => renderShape(shape, i))}
    </svg>
  );
}
