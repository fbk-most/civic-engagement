/** Small hand-drawn SVG charts for the Indicatori tab.
 *
 * Deliberately plain: a year axis, a value axis, and a cursor at the current
 * scenario year that can be moved by clicking the chart. A charting library
 * becomes worth its weight once the requirements for richer interaction
 * (hover read-outs, zooming, comparing scenarios) are clear — not before.
 */

import type { MouseEvent } from "react";
import { locale, tr } from "../i18n/lang";
import { yearLabel } from "../i18n/labels";

const WIDTH = 360;
const HEIGHT = 150;
const MARGIN = { left: 48, right: 10, top: 10, bottom: 22 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;
const YEAR_TICKS = [0, 10, 20, 30];

export interface LineSeries {
  values: (number | null)[];
  variant: "baseline" | "scenario";
}

interface Frame {
  years: number[];
  t: number;
  onSelectYear: (t: number) => void;
}

function xScale(years: number[]) {
  const min = years[0];
  const max = years[years.length - 1];
  return (year: number) => MARGIN.left + ((year - min) / (max - min || 1)) * PLOT_W;
}

/** Round-number bounds and ticks covering [min, max], so axis labels read as
 * 20 / 25 / 30 rather than 21.37 / 25.9 / 30.43. */
function niceTicks(min: number, max: number, count = 3): number[] {
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const rawStep = (max - min) / (count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep) ?? rawStep;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v < max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

function formatTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toLocaleString(locale(), { maximumFractionDigits: 1 })} M`;
  if (abs >= 1e4) return `${(value / 1e3).toLocaleString(locale(), { maximumFractionDigits: 0 })} k`;
  return value.toLocaleString(locale(), { maximumFractionDigits: 1 });
}

/** Clicking anywhere in the plot picks the nearest year. */
function yearAtClick(event: MouseEvent<SVGRectElement>, years: number[]): number {
  const svg = event.currentTarget.ownerSVGElement!;
  const rect = svg.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
  const min = years[0];
  const max = years[years.length - 1];
  const year = Math.round(min + ((x - MARGIN.left) / PLOT_W) * (max - min));
  return Math.min(max, Math.max(min, year));
}

function YearAxis({ years }: { years: number[] }) {
  const x = xScale(years);
  return (
    <g className="chart__axis">
      <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={HEIGHT - MARGIN.bottom} y2={HEIGHT - MARGIN.bottom} />
      {YEAR_TICKS.filter((year) => year >= years[0] && year <= years[years.length - 1]).map((year) => (
        <text key={year} x={x(year)} y={HEIGHT - 6} textAnchor="middle">
          {yearLabel(year)}
        </text>
      ))}
    </g>
  );
}

function Cursor({ years, t, points }: { years: number[]; t: number; points: { y: number; variant: string }[] }) {
  const x = xScale(years)(t);
  return (
    <g className="chart__cursor">
      <line x1={x} x2={x} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} />
      {points.map((point, i) => (
        <circle key={i} cx={x} cy={point.y} r={3.5} className={`chart__dot chart__dot--${point.variant}`} />
      ))}
    </g>
  );
}

function ClickArea({ years, onSelectYear }: Omit<Frame, "t">) {
  return (
    <rect
      className="chart__click-area"
      x={MARGIN.left}
      y={MARGIN.top}
      width={PLOT_W}
      height={PLOT_H}
      onClick={(event) => onSelectYear(yearAtClick(event, years))}
    >
      <title>{tr("Clicca per spostarti a quell'anno", "Click to move to that year")}</title>
    </rect>
  );
}

/** One line per series over the years, sharing a value axis. Nulls (an
 * indicator that isn't defined for some year) break the line.
 *
 * `zeroBased` starts the value axis at zero, so a line's slope shows how big
 * a change is relative to the whole value; without it the axis is fitted to
 * the data, which makes small changes visible but also makes them look
 * dramatic. */
export function LineChart({
  years,
  t,
  onSelectYear,
  series,
  zeroBased,
}: Frame & { series: LineSeries[]; zeroBased: boolean }) {
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (all.length === 0) return <p className="chart__empty">{tr("Non disponibile", "Not available")}</p>;
  const ticks = zeroBased
    ? niceTicks(Math.min(0, ...all), Math.max(0, ...all))
    : niceTicks(Math.min(...all), Math.max(...all));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const x = xScale(years);
  const y = (value: number) => MARGIN.top + (1 - (value - lo) / (hi - lo || 1)) * PLOT_H;

  const paths = series.map((s) => {
    let d = "";
    let penDown = false;
    s.values.forEach((value, i) => {
      if (value === null) {
        penDown = false;
        return;
      }
      d += `${penDown ? "L" : "M"}${x(years[i]).toFixed(1)},${y(value).toFixed(1)}`;
      penDown = true;
    });
    return { d, variant: s.variant };
  });

  const tIndex = years.indexOf(t);
  const cursorPoints = series
    .map((s) => ({ value: s.values[tIndex], variant: s.variant }))
    .filter((p): p is { value: number; variant: LineSeries["variant"] } => p.value !== null && p.value !== undefined)
    .map((p) => ({ y: y(p.value), variant: p.variant }));

  return (
    <svg className="chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img">
      <g className="chart__axis">
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="chart__grid" x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(tick)} y2={y(tick)} />
            <text x={MARGIN.left - 6} y={y(tick) + 3.5} textAnchor="end">
              {formatTick(tick)}
            </text>
          </g>
        ))}
      </g>
      <YearAxis years={years} />
      {paths.map((p, i) => (
        <path key={i} d={p.d} className={`chart__line chart__line--${p.variant}`} />
      ))}
      <Cursor years={years} t={t} points={cursorPoints} />
      <ClickArea years={years} onSelectYear={onSelectYear} />
    </svg>
  );
}

export interface AreaLayer {
  key: string;
  color: string;
  /** Percent of the whole, per year. */
  values: number[];
}

/** Shares of a 0-100% whole stacked over the years (space use by cover). */
export function StackedAreaChart({ years, t, onSelectYear, layers }: Frame & { layers: AreaLayer[] }) {
  const x = xScale(years);
  const y = (pct: number) => MARGIN.top + (1 - pct / 100) * PLOT_H;
  const totals = years.map(() => 0);

  const areas = layers.map((layer) => {
    const lower = [...totals];
    layer.values.forEach((v, i) => {
      totals[i] += v;
    });
    const upper = [...totals];
    const top = years.map((year, i) => `${x(year).toFixed(1)},${y(upper[i]).toFixed(1)}`);
    const bottom = years.map((year, i) => `${x(year).toFixed(1)},${y(lower[i]).toFixed(1)}`).reverse();
    return { key: layer.key, color: layer.color, d: `M${top.join("L")}L${bottom.join("L")}Z` };
  });

  return (
    <svg className="chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img">
      <g className="chart__axis">
        {[0, 50, 100].map((tick) => (
          <text key={tick} x={MARGIN.left - 6} y={y(tick) + 3.5} textAnchor="end">
            {tick}%
          </text>
        ))}
      </g>
      {areas.map((area) => (
        <path key={area.key} d={area.d} fill={area.color} />
      ))}
      <YearAxis years={years} />
      <Cursor years={years} t={t} points={[]} />
      <ClickArea years={years} onSelectYear={onSelectYear} />
    </svg>
  );
}
