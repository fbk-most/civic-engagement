import { useEffect, useMemo, useRef, useState } from "react";
import type { IndicatorDescriptor, IndicatorDescriptors, IndicatorSeries, IndicatorValues, Intervention } from "../api/types";
import { fetchIndicatorSeries } from "../api/client";
import { tr } from "../i18n/lang";
import { coverTypeLabel, yearLabel } from "../i18n/labels";
import { COVER_COLORS } from "../map/layers";
import { LineChart, StackedAreaChart } from "./charts";
import {
  deltaClass,
  formatDelta,
  formatNumber,
  indicatorDelta,
  indicatorLabel,
  indicatorUnit,
  numberValue,
} from "./indicatorFormat";

interface Props {
  descriptors: IndicatorDescriptors;
  interventions: Intervention[];
  t: number;
  onTimeChange: (t: number) => void;
}

/** Marks a read-out as being for the selected year, not the whole series. */
function yearTag(t: number): string {
  return t === 0 ? tr("(oggi)", "(today)") : tr(`(anno +${t})`, `(year +${t})`);
}

function format(value: number | null, d: IndicatorDescriptor): string {
  if (value === null) return tr("n/d", "n/a");
  return `${formatNumber(value, d.decimals)}${indicatorUnit(d)}`;
}

function ChartCard({
  descriptor,
  series,
  t,
  onTimeChange,
  zeroBased,
}: {
  descriptor: IndicatorDescriptor;
  series: IndicatorSeries;
  t: number;
  onTimeChange: (t: number) => void;
  zeroBased: boolean;
}) {
  const get = (values: IndicatorValues) => numberValue(values, descriptor.id);
  const baseline = series.baseline.map(get);
  const scenario = series.scenario.map(get);
  const index = series.years.indexOf(t);
  const current = scenario[index] ?? null;
  const reference = descriptor.scenario_only ? null : (baseline[index] ?? null);
  const change = indicatorDelta(descriptor, current, reference);

  return (
    <div className="indicator-card">
      <h4>{indicatorLabel(descriptor)}</h4>
      <p className="indicator-card__values">
        {!descriptor.scenario_only && (
          <>
            <span className="indicator-card__baseline">{format(reference, descriptor)}</span>
            <span className="indicator-card__arrow">→</span>
          </>
        )}
        <span className="indicator-card__scenario">{format(current, descriptor)}</span>
        {change && <span className={deltaClass("indicator-card", change.improved)}>{formatDelta(descriptor, change.delta)}</span>}
        <span className="indicator-card__year">{yearTag(t)}</span>
      </p>
      <LineChart
        years={series.years}
        t={t}
        zeroBased={zeroBased}
        onSelectYear={onTimeChange}
        series={
          descriptor.scenario_only
            ? [{ values: scenario, variant: "scenario" }]
            : [
                { values: baseline, variant: "baseline" },
                { values: scenario, variant: "scenario" },
              ]
        }
      />
    </div>
  );
}

/** A breakdown's parts at one year; {} if missing. */
function partsOf(values: IndicatorValues | undefined, id: string): Record<string, number> {
  const value = values?.[id];
  return value !== null && typeof value === "object" ? (value as Record<string, number>) : {};
}

/** A breakdown over the cover types (the space use): their labels and
 * colours are still the frontend's (see IndicatorDescriptor's `parts`). */
function BreakdownCard({
  descriptor,
  series,
  t,
  onTimeChange,
}: {
  descriptor: IndicatorDescriptor;
  series: IndicatorSeries;
  t: number;
  onTimeChange: (t: number) => void;
}) {
  const parts = (values: IndicatorValues | undefined) => partsOf(values, descriptor.id);
  // One shared stacking order for both charts, so the same cover sits at the
  // same height in each and the two can be compared at a glance.
  const coverTypes = Array.from(
    new Set([...series.baseline, ...series.scenario].flatMap((i) => Object.keys(parts(i))))
  ).sort((a, b) => Object.keys(COVER_COLORS).indexOf(a) - Object.keys(COVER_COLORS).indexOf(b));
  const layersFor = (list: IndicatorValues[]) =>
    coverTypes.map((type) => ({
      key: type,
      color: COVER_COLORS[type] ?? "#c9c6bd",
      values: list.map((i) => parts(i)[type] ?? 0),
    }));
  const index = series.years.indexOf(t);

  return (
    <div className="indicator-card indicator-card--wide">
      <h4>{indicatorLabel(descriptor)}</h4>
      <div className="indicator-card__pair">
        <div>
          <p className="indicator-card__subtitle">{tr("Situazione attuale", "Current situation")}</p>
          <StackedAreaChart years={series.years} t={t} onSelectYear={onTimeChange} layers={layersFor(series.baseline)} />
        </div>
        <div>
          <p className="indicator-card__subtitle">{tr("Simulazione", "Simulation")}</p>
          <StackedAreaChart years={series.years} t={t} onSelectYear={onTimeChange} layers={layersFor(series.scenario)} />
        </div>
      </div>
      <div className="indicator-card__legend">
        {coverTypes.map((type) => (
          <span key={type} className="indicator-card__legend-item">
            <span className="indicator-card__swatch" style={{ background: COVER_COLORS[type] ?? "#c9c6bd" }} />
            {coverTypeLabel(type)}{" "}
            <span className="indicator-card__legend-values">
              {parts(series.baseline[index])[type] ?? 0}
              {indicatorUnit(descriptor)} → {parts(series.scenario[index])[type] ?? 0}
              {indicatorUnit(descriptor)}
            </span>
          </span>
        ))}
        <span className="indicator-card__year">{yearTag(t)}</span>
      </div>
    </div>
  );
}

/** A flags indicator's flags at one year; null if missing. */
function flagsOf(values: IndicatorValues | undefined, id: string): Record<string, boolean> | null {
  const value = values?.[id];
  return value !== null && typeof value === "object" ? (value as Record<string, boolean>) : null;
}

function FlagsCard({ descriptor, series, t }: { descriptor: IndicatorDescriptor; series: IndicatorSeries; t: number }) {
  const index = series.years.indexOf(t);
  const baseline = flagsOf(series.baseline[index], descriptor.id);
  const scenario = flagsOf(series.scenario[index], descriptor.id);
  if (!baseline || !scenario) return null;
  return (
    <div className="indicator-card">
      <h4>
        {indicatorLabel(descriptor)} <span className="indicator-card__year">{yearTag(t)}</span>
      </h4>
      <table className="indicator-card__table">
        <thead>
          <tr>
            <th />
            <th>{tr("Attuale", "Current")}</th>
            <th>{tr("Simulazione", "Simulation")}</th>
          </tr>
        </thead>
        <tbody>
          {descriptor.parts.map((part) => (
            <tr key={part.id}>
              <td>{tr(part.label, part.label_en)}</td>
              <td>{baseline[part.id] ? "✓" : "—"}</td>
              <td className={scenario[part.id] && !baseline[part.id] ? "indicator-card__gain" : undefined}>
                {scenario[part.id] ? "✓" : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The "Indicatori" tab: every indicator over the whole 30-year horizon,
 * current situation vs. simulation, with the selected year as a cursor. */
export function IndicatorsView({ descriptors, interventions, t, onTimeChange }: Props) {
  const [series, setSeries] = useState<IndicatorSeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [zeroBased, setZeroBased] = useState(true);
  const requestSeqRef = useRef(0);

  // Keyed on the interventions' content, not the scene object: the scene is
  // replaced on every year change too, and moving the year must not refetch
  // a series that already covers every year.
  const interventionsKey = useMemo(() => JSON.stringify(interventions), [interventions]);

  useEffect(() => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setFailed(false);
    fetchIndicatorSeries()
      .then((result) => {
        if (seq !== requestSeqRef.current) return;
        setSeries(result);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        if (seq !== requestSeqRef.current) return;
        setFailed(true);
        setLoading(false);
      });
  }, [interventionsKey]);

  return (
    <div className="indicators-view">
      <div className="indicators-view__inner">
        <header className="indicators-view__header">
          <h2>{tr("Indicatori", "Indicators")} · {yearLabel(t)}</h2>
          <div className="indicators-view__legend">
            <span className="indicators-view__legend-item">
              <svg width="28" height="8">
                <line x1="0" x2="28" y1="4" y2="4" className="chart__line chart__line--baseline" />
              </svg>
              {tr("Situazione attuale", "Current situation")}
            </span>
            <span className="indicators-view__legend-item">
              <svg width="28" height="8">
                <line x1="0" x2="28" y1="4" y2="4" className="chart__line chart__line--scenario" />
              </svg>
              {tr("Simulazione (con gli interventi)", "Simulation (with the interventions)")}
            </span>
            {loading && <span className="indicators-view__status">{tr("Calcolo delle serie in corso…", "Computing the series…")}</span>}
            {failed && <span className="indicators-view__status">{tr("Impossibile calcolare le serie", "Could not compute the series")}</span>}
          </div>
          <div className="indicators-view__options">
            <p className="indicators-view__hint">{tr("Clicca su un grafico per spostarti a quell'anno.", "Click on a chart to move to that year.")}</p>
            <div className="indicators-view__scale" role="group" aria-label={tr("Scala dei grafici", "Chart scale")}>
              <span>{tr("Scala:", "Scale:")}</span>
              <button type="button" aria-pressed={zeroBased} onClick={() => setZeroBased(true)}>
                {tr("Da zero", "From zero")}
              </button>
              <button
                type="button"
                aria-pressed={!zeroBased}
                onClick={() => setZeroBased(false)}
                title={tr(
                  "Adatta la scala ai valori: rende visibili le piccole variazioni, ma le fa sembrare più grandi",
                  "Fit the scale to the values: makes small changes visible, but makes them look bigger"
                )}
              >
                {tr("Adattata ai valori", "Fitted to the values")}
              </button>
            </div>
          </div>
        </header>

        {series &&
          descriptors.groups.map((group) => {
            const charted = descriptors.indicators.filter((d) => d.group === group.id && d.chart);
            if (charted.length === 0) return null;
            return (
              <section key={group.id}>
                {group.label !== null && <h3>{tr(group.label, group.label_en ?? group.label)}</h3>}
                <div className="indicators-view__grid">
                  {charted.map((d) =>
                    d.kind === "breakdown" ? (
                      <BreakdownCard key={d.id} descriptor={d} series={series} t={t} onTimeChange={onTimeChange} />
                    ) : d.kind === "flags" ? (
                      <FlagsCard key={d.id} descriptor={d} series={series} t={t} />
                    ) : (
                      <ChartCard
                        key={d.id}
                        descriptor={d}
                        series={series}
                        t={t}
                        onTimeChange={onTimeChange}
                        zeroBased={zeroBased}
                      />
                    )
                  )}
                </div>
              </section>
            );
          })}
      </div>
    </div>
  );
}
