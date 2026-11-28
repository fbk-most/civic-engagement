import { useEffect, useMemo, useRef, useState } from "react";
import type { IndicatorDescriptor, IndicatorDescriptors, IndicatorSeries, IndicatorValues, Intervention } from "../api/types";
import { fetchIndicatorSeries } from "../api/client";
import { tr } from "../i18n/lang";
import { coverTypeLabel, yearLabel } from "../i18n/labels";
import type { ComparedSource } from "../comparison";
import { activePack } from "../pack";
import { LineChart, StackedAreaChart, type LineVariant } from "./charts";
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
  // The current situation only, as the KPI panel's: no simulation.
  asIs: boolean;
  t: number;
  onTimeChange: (t: number) => void;
  /** Two scenarios compared, A and B, each beside the as-is: their curves
   * in place of the simulation's. */
  comparison?: { a: ComparedSource; b: ComparedSource };
}

/** One curve of every chart, one column of every table: the as-is, the
 * simulation, or a scenario compared. */
interface Line {
  variant: LineVariant;
  label: string;
  values: IndicatorValues[];
}

const isCompared = (variant: LineVariant): variant is "a" | "b" => variant === "a" || variant === "b";

/** Marks a read-out as being for the selected year, not the whole series. */
function yearTag(t: number): string {
  return t === 0 ? tr("(oggi)", "(today)") : tr(`(anno +${t})`, `(year +${t})`);
}

function format(value: number | null, d: IndicatorDescriptor): string {
  if (value === null) return tr("n/d", "n/a");
  return `${formatNumber(value, d.decimals)}${indicatorUnit(d)}`;
}

/** A compared scenario's letter, in its colour (as in the top bar's
 * picker); nothing for the others. */
function Letter({ variant }: { variant: LineVariant }) {
  if (!isCompared(variant)) return null;
  return <span className={`comparison-picker__letter comparison-picker__letter--${variant}`}>{variant.toUpperCase()}</span>;
}

function ChartCard({
  descriptor,
  lines,
  years,
  t,
  onTimeChange,
  zeroBased,
}: {
  descriptor: IndicatorDescriptor;
  lines: Line[];
  years: number[];
  t: number;
  onTimeChange: (t: number) => void;
  zeroBased: boolean;
}) {
  const get = (values: IndicatorValues) => numberValue(values, descriptor);
  const index = years.indexOf(t);
  // An indicator only a scenario has: no as-is curve.
  const charted = lines
    .filter((line) => !(descriptor.scenario_only && line.variant === "baseline"))
    .map((line) => ({ variant: line.variant, values: line.values.map(get) }));
  const at = (variant: LineVariant) => charted.find((line) => line.variant === variant)?.values[index] ?? null;
  const reference = at("baseline");
  const last = charted[charted.length - 1];

  return (
    <div className="indicator-card">
      <h4>{indicatorLabel(descriptor)}</h4>
      {charted.some((line) => line.variant === "a") ? (
        <ComparedValues descriptor={descriptor} a={at("a")} b={at("b")} reference={reference} t={t} />
      ) : (
        last && (
          <SingleValues
            descriptor={descriptor}
            value={at(last.variant)}
            reference={last.variant === "baseline" ? null : reference}
            t={t}
          />
        )
      )}
      <LineChart years={years} t={t} zeroBased={zeroBased} onSelectYear={onTimeChange} series={charted} />
    </div>
  );
}

/** The as-is → the simulation, and the change. */
function SingleValues({
  descriptor,
  value,
  reference,
  t,
}: {
  descriptor: IndicatorDescriptor;
  value: number | null;
  reference: number | null;
  t: number;
}) {
  const change = indicatorDelta(descriptor, value, reference);
  return (
    <p className="indicator-card__values">
      {reference !== null && (
        <>
          <span className="indicator-card__baseline">{format(reference, descriptor)}</span>
          <span className="indicator-card__arrow">→</span>
        </>
      )}
      <span className="indicator-card__scenario">{format(value, descriptor)}</span>
      {change && <span className={deltaClass("indicator-card", change.improved)}>{formatDelta(descriptor, change.delta)}</span>}
      <span className="indicator-card__year">{yearTag(t)}</span>
    </p>
  );
}

/** The as-is; A and B, each with its change from the as-is (none for an
 * indicator only a scenario has); and B − A. */
function ComparedValues({
  descriptor,
  a,
  b,
  reference,
  t,
}: {
  descriptor: IndicatorDescriptor;
  a: number | null;
  b: number | null;
  reference: number | null;
  t: number;
}) {
  const side = (variant: "a" | "b", value: number | null) => {
    const change = indicatorDelta(descriptor, value, reference);
    return (
      <span className="indicator-card__side">
        <Letter variant={variant} />
        <span className={`indicator-card__value--${variant}`}>{format(value, descriptor)}</span>
        {change && <span className={deltaClass("indicator-card", change.improved)}>{formatDelta(descriptor, change.delta)}</span>}
      </span>
    );
  };
  const difference = indicatorDelta(descriptor, b, a);
  return (
    <p className="indicator-card__values indicator-card__values--compared">
      {reference !== null && (
        <span className="indicator-card__side indicator-card__baseline">
          {tr("Attuale", "Current")} {format(reference, descriptor)}
        </span>
      )}
      {side("a", a)}
      {side("b", b)}
      <span className="indicator-card__side" title={tr("Differenza tra B e A", "Difference between B and A")}>
        <span className="indicator-card__baseline">B − A</span>
        {difference ? (
          <span className={deltaClass("indicator-card", difference.improved)}>{formatDelta(descriptor, difference.delta)}</span>
        ) : (
          <span className="indicator-card__delta">{a === null || b === null ? tr("n/d", "n/a") : "="}</span>
        )}
      </span>
      <span className="indicator-card__year">{yearTag(t)}</span>
    </p>
  );
}

/** A breakdown's parts at one year; {} if missing. */
function partsOf(values: IndicatorValues | undefined, id: string): Record<string, number> {
  const value = values?.[id];
  return value !== null && typeof value === "object" ? (value as Record<string, number>) : {};
}

/** A breakdown over the cover types (the space use): their labels and
 * colours are the frontend pack's (see IndicatorDescriptor's `parts`). One
 * chart per line. */
function BreakdownCard({
  descriptor,
  lines,
  years,
  t,
  onTimeChange,
}: {
  descriptor: IndicatorDescriptor;
  lines: Line[];
  years: number[];
  t: number;
  onTimeChange: (t: number) => void;
}) {
  const parts = (values: IndicatorValues | undefined) => partsOf(values, descriptor.id);
  // One shared stacking order for every chart, so the same cover sits at
  // the same height in each and they can be compared at a glance: the pack's.
  const covers = activePack().coverTypes;
  const order = Object.keys(covers);
  const coverColor = (type: string) => covers[type]?.color ?? "#c9c6bd";
  const coverTypes = Array.from(new Set(lines.flatMap((line) => line.values.flatMap((i) => Object.keys(parts(i)))))).sort(
    (a, b) => order.indexOf(a) - order.indexOf(b)
  );
  const layersFor = (list: IndicatorValues[]) =>
    coverTypes.map((type) => ({
      key: type,
      color: coverColor(type),
      values: list.map((i) => parts(i)[type] ?? 0),
    }));
  const index = years.indexOf(t);
  const unit = indicatorUnit(descriptor);
  // Two lines: as-is → simulation. Three: each with its letter.
  const valuesAt = (type: string) =>
    lines
      .map((line) => `${isCompared(line.variant) ? `${line.variant.toUpperCase()} ` : ""}${parts(line.values[index])[type] ?? 0}${unit}`)
      .join(lines.length > 2 ? " · " : " → ");

  return (
    <div className="indicator-card indicator-card--wide">
      <h4>{indicatorLabel(descriptor)}</h4>
      <div className={lines.length > 2 ? "indicator-card__pair indicator-card__pair--3" : "indicator-card__pair"}>
        {lines.map((line) => (
          <div key={line.variant}>
            <p className="indicator-card__subtitle">
              <Letter variant={line.variant} />
              {line.label}
            </p>
            <StackedAreaChart years={years} t={t} onSelectYear={onTimeChange} layers={layersFor(line.values)} />
          </div>
        ))}
      </div>
      <div className="indicator-card__legend">
        {coverTypes.map((type) => (
          <span key={type} className="indicator-card__legend-item">
            <span className="indicator-card__swatch" style={{ background: coverColor(type) }} />
            {coverTypeLabel(type)} <span className="indicator-card__legend-values">{valuesAt(type)}</span>
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

/** A flags indicator: a column per line, a flag gained on the as-is
 * marked. */
function FlagsCard({
  descriptor,
  lines,
  years,
  t,
}: {
  descriptor: IndicatorDescriptor;
  lines: Line[];
  years: number[];
  t: number;
}) {
  const index = years.indexOf(t);
  const columns = lines.map((line) => ({ variant: line.variant, flags: flagsOf(line.values[index], descriptor.id) }));
  if (columns.some((column) => column.flags === null)) return null;
  const baseline = columns.find((column) => column.variant === "baseline")?.flags ?? null;
  const heading = (variant: LineVariant) =>
    variant === "baseline" ? tr("Attuale", "Current") : variant === "scenario" ? tr("Simulazione", "Simulation") : <Letter variant={variant} />;
  return (
    <div className="indicator-card">
      <h4>
        {indicatorLabel(descriptor)} <span className="indicator-card__year">{yearTag(t)}</span>
      </h4>
      <table className="indicator-card__table">
        <thead>
          <tr>
            <th />
            {columns.map(({ variant }) => (
              <th key={variant}>{heading(variant)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {descriptor.parts.map((part) => (
            <tr key={part.id}>
              <td>{tr(part.label, part.label_en)}</td>
              {columns.map(({ variant, flags }) => {
                const on = flags?.[part.id] ?? false;
                const gained = variant !== "baseline" && on && baseline !== null && !baseline[part.id];
                return (
                  <td key={variant} className={gained ? "indicator-card__gain" : undefined}>
                    {on ? "✓" : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A series, fetched again whenever `key` changes; none while `source` is
 * undefined (a side not compared). */
function useSeries(source: string | null | undefined, key: string) {
  const [series, setSeries] = useState<IndicatorSeries | null>(null);
  const [loading, setLoading] = useState(source !== undefined);
  const [failed, setFailed] = useState(false);
  const requestSeqRef = useRef(0);

  // `key` says when what `source` shows has changed (`source` itself too).
  useEffect(() => {
    const seq = ++requestSeqRef.current;
    if (source === undefined) {
      setSeries(null);
      setLoading(false);
      setFailed(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    fetchIndicatorSeries(source)
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
  }, [source, key]);

  return { series, loading, failed };
}

/** The "Indicatori" tab: every indicator over the whole 30-year horizon,
 * current situation vs. simulation — or vs. two scenarios compared, A and
 * B — with the selected year as a cursor. */
export function IndicatorsView({ descriptors, interventions, asIs, t, onTimeChange, comparison }: Props) {
  const [zeroBased, setZeroBased] = useState(true);

  // Keyed on the interventions' content, not the scene object: the scene is
  // replaced on every year change too, and moving the year must not refetch
  // a series that already covers every year.
  const interventionsKey = useMemo(() => JSON.stringify(interventions), [interventions]);
  // A side's series carries the as-is too: the first's is used.
  const first = useSeries(comparison ? comparison.a.scenario : null, comparison ? `a:${comparison.a.key}` : interventionsKey);
  const second = useSeries(comparison?.b.scenario, comparison ? `b:${comparison.b.key}` : "none");
  const loading = first.loading || second.loading;
  const failed = first.failed || second.failed;

  const lines = useMemo((): Line[] | null => {
    if (!first.series) return null;
    const baseline: Line = { variant: "baseline", label: tr("Situazione attuale", "Current situation"), values: first.series.baseline };
    if (comparison) {
      if (!second.series) return null;
      return [
        baseline,
        { variant: "a", label: comparison.a.label, values: first.series.scenario },
        { variant: "b", label: comparison.b.label, values: second.series.scenario },
      ];
    }
    if (asIs) return [baseline];
    return [baseline, { variant: "scenario", label: tr("Simulazione", "Simulation"), values: first.series.scenario }];
  }, [first.series, second.series, comparison, asIs]);
  const years = first.series?.years ?? [];

  return (
    <div className="indicators-view">
      <div className="indicators-view__inner">
        <header className="indicators-view__header">
          <h2>{tr("Indicatori", "Indicators")} · {yearLabel(t)}</h2>
          <div className="indicators-view__legend">
            {(lines ?? []).map((line) => (
              <span key={line.variant} className="indicators-view__legend-item">
                <svg width="28" height="8">
                  <line x1="0" x2="28" y1="4" y2="4" className={`chart__line chart__line--${line.variant}`} />
                </svg>
                <Letter variant={line.variant} />
                {line.variant === "scenario" ? tr("Simulazione (con gli interventi)", "Simulation (with the interventions)") : line.label}
              </span>
            ))}
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

        {lines &&
          descriptors.groups.map((group) => {
            // The as-is alone: no indicator only a scenario has.
            const charted = descriptors.indicators.filter(
              (d) => d.group === group.id && d.chart && !(lines.length === 1 && d.scenario_only)
            );
            if (charted.length === 0) return null;
            return (
              <section key={group.id}>
                {group.label !== null && <h3>{tr(group.label, group.label_en ?? group.label)}</h3>}
                <div className="indicators-view__grid">
                  {charted.map((d) =>
                    d.kind === "breakdown" ? (
                      <BreakdownCard key={d.id} descriptor={d} lines={lines} years={years} t={t} onTimeChange={onTimeChange} />
                    ) : d.kind === "flags" ? (
                      <FlagsCard key={d.id} descriptor={d} lines={lines} years={years} t={t} />
                    ) : (
                      <ChartCard
                        key={d.id}
                        descriptor={d}
                        lines={lines}
                        years={years}
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
