/** A share (0-1) hour by hour through one day, small enough for a side
 * panel: the current situation and, when there are interventions, the
 * situation with them — styled like the Indicatori tab's charts (charts.tsx)
 * — and, for a later year, today's situation, for comparison.
 *
 * A cursor marks the hour shown; hovering reads out any hour, and clicking
 * moves the scene to it.
 */

import { useState, type MouseEvent } from "react";
import { formatHour } from "../three/sun";
import { tr } from "../i18n/lang";

const WIDTH = 208;
const HEIGHT = 78;
const MARGIN = { left: 30, right: 6, top: 6, bottom: 14 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;
const HOUR_TICKS = [0, 6, 12, 18, 24];
const VALUE_TICKS = [0, 0.5, 1];

type Values = (number | null)[];

interface Props {
  title: string;
  current: Values;
  /** With the interventions; null when there are none. */
  planned: Values | null;
  /** Today without the interventions, when `current` is a later year's;
   * null otherwise. */
  today: Values | null;
  hour: number;
  onHourChange: (hour: number) => void;
  /** Another day's curve, up while the right one is computed. */
  stale: boolean;
}

const x = (hour: number) => MARGIN.left + (hour / 24) * PLOT_W;
const y = (value: number) => MARGIN.top + (1 - value) * PLOT_H;

/** At a fractional hour, between the hourly values (wrapping at midnight,
 * like the field). */
function valueAt(values: Values, hour: number): number | null {
  const h0 = Math.floor(hour) % values.length;
  const h1 = (h0 + 1) % values.length;
  const a = values[h0];
  const b = values[h1];
  if (a === null || b === null) return a ?? b;
  return a + (b - a) * (hour - Math.floor(hour));
}

/** Hourly points, plus midnight again at the right edge. */
function path(values: Values): string {
  let d = "";
  let penDown = false;
  [...values, values[0]].forEach((value, hour) => {
    if (value === null) {
      penDown = false;
      return;
    }
    d += `${penDown ? "L" : "M"}${x(hour).toFixed(1)},${y(value).toFixed(1)}`;
    penDown = true;
  });
  return d;
}

function percent(value: number | null): string {
  return value === null ? "–" : `${Math.round(value * 100)}%`;
}

function hourAt(event: MouseEvent<SVGRectElement>): number {
  const rect = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
  const svgX = ((event.clientX - rect.left) / rect.width) * WIDTH;
  return Math.min(24, Math.max(0, ((svgX - MARGIN.left) / PLOT_W) * 24));
}

export function DailyChart({ title, current, planned, today, hour, onHourChange, stale }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);
  const readHour = hovered ?? hour;
  const series = [
    ...(today ? [{ values: today, variant: "today" }] : []),
    ...(planned
      ? [
          { values: current, variant: "baseline" },
          { values: planned, variant: "scenario" },
        ]
      : [{ values: current, variant: "only" }]),
  ];

  return (
    <div className={`daily-chart${stale ? " daily-chart--stale" : ""}`}>
      <div className="daily-chart__head">
        <span>{title}</span>
        <span className="daily-chart__readout">
          {hovered !== null && <span className="daily-chart__hour">{formatHour(readHour % 24)} </span>}
          {today && (
            <>
              <span className="daily-chart__today" title={tr("Oggi", "Today")}>
                {percent(valueAt(today, readHour))}
              </span>
              {" · "}
            </>
          )}
          {planned ? (
            <>
              <span title={tr("Situazione attuale", "Current situation")}>{percent(valueAt(current, readHour))}</span>
              {" → "}
              <strong title={tr("Con le proposte", "With the proposals")}>{percent(valueAt(planned, readHour))}</strong>
            </>
          ) : (
            <strong>{percent(valueAt(current, readHour))}</strong>
          )}
        </span>
      </div>
      <svg className="chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={title}>
        <g className="chart__axis">
          {VALUE_TICKS.map((tick) => (
            <g key={tick}>
              <line className="chart__grid" x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(tick)} y2={y(tick)} />
              <text x={MARGIN.left - 4} y={y(tick) + 3.5} textAnchor="end">
                {tick * 100}%
              </text>
            </g>
          ))}
          {HOUR_TICKS.map((tick) => (
            <text key={tick} x={x(tick)} y={HEIGHT - 3} textAnchor="middle">
              {tick}
            </text>
          ))}
        </g>
        {series.map((s) => (
          <path key={s.variant} d={path(s.values)} className={`chart__line chart__line--${s.variant}`} />
        ))}
        <g className="chart__cursor">
          <line x1={x(hour)} x2={x(hour)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} />
          {series.map((s) => {
            const value = valueAt(s.values, hour);
            return value === null ? null : (
              <circle key={s.variant} cx={x(hour)} cy={y(value)} r={3} className={`chart__dot chart__dot--${s.variant}`} />
            );
          })}
        </g>
        {hovered !== null && (
          <line
            className="daily-chart__crosshair"
            x1={x(hovered)}
            x2={x(hovered)}
            y1={MARGIN.top}
            y2={HEIGHT - MARGIN.bottom}
          />
        )}
        <rect
          className="chart__click-area"
          x={MARGIN.left}
          y={0}
          width={PLOT_W}
          height={HEIGHT}
          onPointerMove={(event) => setHovered(Math.round(hourAt(event) * 2) / 2)}
          onPointerLeave={() => setHovered(null)}
          onClick={(event) => onHourChange((Math.round(hourAt(event) * 2) / 2) % 24)}
        >
          <title>{tr("Clicca per spostarti a quell'ora", "Click to move to that hour")}</title>
        </rect>
      </svg>
    </div>
  );
}
