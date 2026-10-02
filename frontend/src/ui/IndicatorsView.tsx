import { useEffect, useMemo, useRef, useState } from "react";
import type { IndicatorSeries, Indicators, Intervention } from "../api/types";
import { fetchIndicatorSeries } from "../api/client";
import { COVER_TYPE_LABELS_IT, yearLabel } from "../i18n/labels";
import { COVER_COLORS } from "../map/layers";
import { LineChart, StackedAreaChart } from "./charts";

interface Props {
  interventions: Intervention[];
  t: number;
  onTimeChange: (t: number) => void;
}

interface LineSpec {
  title: string;
  unit: string;
  decimals: number;
  get: (indicators: Indicators) => number | null;
  /** Which way a change counts as an improvement, for the delta's colour. */
  betterWhen: "higher" | "lower";
  /** Only meaningful with interventions (e.g. their cost), so no "attuale" line. */
  scenarioOnly?: boolean;
}

const SECTIONS: { title: string; charts: LineSpec[] }[] = [
  {
    title: "Clima e ambiente",
    charts: [
      {
        title: "Temperatura estiva stimata",
        unit: " °C",
        decimals: 1,
        get: (i) => i.thermal_comfort.estimated_temperature_c,
        betterWhen: "lower",
      },
      {
        title: "CO₂ assorbita all'anno",
        unit: " kg/anno",
        decimals: 0,
        get: (i) => i.co2.annual_rate_kg,
        betterWhen: "higher",
      },
      {
        title: "CO₂ assorbita da oggi (cumulata)",
        unit: " kg",
        decimals: 0,
        get: (i) => i.co2.cumulative_kg,
        betterWhen: "higher",
      },
    ],
  },
  {
    title: "Accessibilità",
    charts: [
      {
        title: "Percorribilità pedonale",
        unit: "",
        decimals: 1,
        get: (i) => i.accessibility.walkability_score,
        betterWhen: "higher",
      },
      {
        title: "Percorsi fragili",
        unit: "%",
        decimals: 1,
        get: (i) => i.accessibility.fragile_path_pct,
        betterWhen: "lower",
      },
    ],
  },
  {
    title: "Sicurezza e inclusività",
    charts: [
      {
        title: "Sicurezza percepita",
        unit: "%",
        decimals: 1,
        get: (i) => i.social.safety_score,
        betterWhen: "higher",
      },
      {
        title: "Utilizzo serale/invernale",
        unit: "%",
        decimals: 1,
        get: (i) => i.social.evening_winter_score,
        betterWhen: "higher",
      },
    ],
  },
  {
    title: "Costi",
    charts: [
      {
        title: "Costo degli interventi realizzati",
        unit: " €",
        decimals: 0,
        get: (i) => i.cost_eur,
        betterWhen: "lower",
        scenarioOnly: true,
      },
    ],
  },
];

const AGE_GROUPS: { key: keyof Indicators["social"]["age_inclusivity"]; label: string }[] = [
  { key: "bambini", label: "Bambini" },
  { key: "giovani", label: "Giovani" },
  { key: "generale", label: "Generale" },
];

/** Marks a read-out as being for the selected year, not the whole series. */
function yearTag(t: number): string {
  return t === 0 ? "(oggi)" : `(anno +${t})`;
}

function format(value: number | null, decimals: number, unit: string): string {
  if (value === null) return "n/d";
  return `${value.toLocaleString("it-IT", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${unit}`;
}

function ChartCard({
  spec,
  series,
  t,
  onTimeChange,
  zeroBased,
}: {
  spec: LineSpec;
  series: IndicatorSeries;
  t: number;
  onTimeChange: (t: number) => void;
  zeroBased: boolean;
}) {
  const baseline = series.baseline.map(spec.get);
  const scenario = series.scenario.map(spec.get);
  const index = series.years.indexOf(t);
  const current = scenario[index] ?? null;
  const reference = spec.scenarioOnly ? null : (baseline[index] ?? null);
  const delta = current !== null && reference !== null ? current - reference : null;
  const changed = delta !== null && Math.abs(delta) >= 5 * 10 ** -(spec.decimals + 1);
  const improved = delta !== null && (spec.betterWhen === "higher" ? delta > 0 : delta < 0);

  return (
    <div className="indicator-card">
      <h4>{spec.title}</h4>
      <p className="indicator-card__values">
        {!spec.scenarioOnly && (
          <>
            <span className="indicator-card__baseline">{format(reference, spec.decimals, spec.unit)}</span>
            <span className="indicator-card__arrow">→</span>
          </>
        )}
        <span className="indicator-card__scenario">{format(current, spec.decimals, spec.unit)}</span>
        {changed && (
          <span className={improved ? "indicator-card__delta indicator-card__delta--better" : "indicator-card__delta indicator-card__delta--worse"}>
            {delta! > 0 ? "+" : ""}
            {delta!.toLocaleString("it-IT", { maximumFractionDigits: spec.decimals })}
          </span>
        )}
        <span className="indicator-card__year">{yearTag(t)}</span>
      </p>
      <LineChart
        years={series.years}
        t={t}
        zeroBased={zeroBased}
        onSelectYear={onTimeChange}
        series={
          spec.scenarioOnly
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

function SpaceUseCard({
  series,
  t,
  onTimeChange,
}: {
  series: IndicatorSeries;
  t: number;
  onTimeChange: (t: number) => void;
}) {
  // One shared stacking order for both charts, so the same cover sits at the
  // same height in each and the two can be compared at a glance.
  const coverTypes = Array.from(
    new Set([...series.baseline, ...series.scenario].flatMap((i) => Object.keys(i.space_use_pct)))
  ).sort((a, b) => Object.keys(COVER_COLORS).indexOf(a) - Object.keys(COVER_COLORS).indexOf(b));
  const layersFor = (list: Indicators[]) =>
    coverTypes.map((type) => ({
      key: type,
      color: COVER_COLORS[type] ?? "#c9c6bd",
      values: list.map((i) => i.space_use_pct[type] ?? 0),
    }));
  const index = series.years.indexOf(t);

  return (
    <div className="indicator-card indicator-card--wide">
      <h4>Uso dello spazio</h4>
      <div className="indicator-card__pair">
        <div>
          <p className="indicator-card__subtitle">Situazione attuale</p>
          <StackedAreaChart years={series.years} t={t} onSelectYear={onTimeChange} layers={layersFor(series.baseline)} />
        </div>
        <div>
          <p className="indicator-card__subtitle">Simulazione</p>
          <StackedAreaChart years={series.years} t={t} onSelectYear={onTimeChange} layers={layersFor(series.scenario)} />
        </div>
      </div>
      <div className="indicator-card__legend">
        {coverTypes.map((type) => (
          <span key={type} className="indicator-card__legend-item">
            <span className="indicator-card__swatch" style={{ background: COVER_COLORS[type] ?? "#c9c6bd" }} />
            {COVER_TYPE_LABELS_IT[type] ?? type}{" "}
            <span className="indicator-card__legend-values">
              {series.baseline[index]?.space_use_pct[type] ?? 0}% → {series.scenario[index]?.space_use_pct[type] ?? 0}%
            </span>
          </span>
        ))}
        <span className="indicator-card__year">{yearTag(t)}</span>
      </div>
    </div>
  );
}

function InclusivityCard({ series, t }: { series: IndicatorSeries; t: number }) {
  const index = series.years.indexOf(t);
  const baseline = series.baseline[index]?.social.age_inclusivity;
  const scenario = series.scenario[index]?.social.age_inclusivity;
  if (!baseline || !scenario) return null;
  return (
    <div className="indicator-card">
      <h4>
        Spazio adatto a… <span className="indicator-card__year">{yearTag(t)}</span>
      </h4>
      <table className="indicator-card__table">
        <thead>
          <tr>
            <th />
            <th>Attuale</th>
            <th>Simulazione</th>
          </tr>
        </thead>
        <tbody>
          {AGE_GROUPS.map((group) => (
            <tr key={group.key}>
              <td>{group.label}</td>
              <td>{baseline[group.key] ? "✓" : "—"}</td>
              <td className={scenario[group.key] && !baseline[group.key] ? "indicator-card__gain" : undefined}>
                {scenario[group.key] ? "✓" : "—"}
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
export function IndicatorsView({ interventions, t, onTimeChange }: Props) {
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
          <h2>Indicatori · {yearLabel(t)}</h2>
          <div className="indicators-view__legend">
            <span className="indicators-view__legend-item">
              <svg width="28" height="8">
                <line x1="0" x2="28" y1="4" y2="4" className="chart__line chart__line--baseline" />
              </svg>
              Situazione attuale
            </span>
            <span className="indicators-view__legend-item">
              <svg width="28" height="8">
                <line x1="0" x2="28" y1="4" y2="4" className="chart__line chart__line--scenario" />
              </svg>
              Simulazione (con gli interventi)
            </span>
            {loading && <span className="indicators-view__status">Calcolo delle serie in corso…</span>}
            {failed && <span className="indicators-view__status">Impossibile calcolare le serie</span>}
          </div>
          <div className="indicators-view__options">
            <p className="indicators-view__hint">Clicca su un grafico per spostarti a quell'anno.</p>
            <div className="indicators-view__scale" role="group" aria-label="Scala dei grafici">
              <span>Scala:</span>
              <button type="button" aria-pressed={zeroBased} onClick={() => setZeroBased(true)}>
                Da zero
              </button>
              <button
                type="button"
                aria-pressed={!zeroBased}
                onClick={() => setZeroBased(false)}
                title="Adatta la scala ai valori: rende visibili le piccole variazioni, ma le fa sembrare più grandi"
              >
                Adattata ai valori
              </button>
            </div>
          </div>
        </header>

        {series && (
          <>
            <section>
              <div className="indicators-view__grid">
                <SpaceUseCard series={series} t={t} onTimeChange={onTimeChange} />
              </div>
            </section>
            {SECTIONS.map((section) => (
              <section key={section.title}>
                <h3>{section.title}</h3>
                <div className="indicators-view__grid">
                  {section.charts.map((spec) => (
                    <ChartCard
                      key={spec.title}
                      spec={spec}
                      series={series}
                      t={t}
                      onTimeChange={onTimeChange}
                      zeroBased={zeroBased}
                    />
                  ))}
                  {section.title === "Sicurezza e inclusività" && <InclusivityCard series={series} t={t} />}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
