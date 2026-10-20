import { formatHour } from "../three/sun";
import type { CrowdExposure, GroupExposure } from "../three/people/comfort";
import type { HourComfort } from "../three/people/daily";
import { DailyChart } from "./DailyChart";
import { locale, tr } from "../i18n/lang";
import { fromCelsius, tempSymbol } from "../i18n/units";
import { FELT_STOPS, STRESS_BANDS, summaryAt, type ThermalField, type ThermalReading } from "../thermal/field";

interface Props {
  /** The panel's figures shown, and the field drawn on the ground:
   * independent choices. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fieldShown: boolean;
  onFieldShownChange: (shown: boolean) => void;
  field: ThermalField | null;
  loading: boolean;
  failed: boolean;
  hour: number;
  onHourChange: (hour: number) => void;
  /** Under the pointer, or where the 3D walker stands. */
  reading: ThermalReading;
  /** How the 3D view's people fare; null outside the 3D view, with no
   * people, or before the field is there. */
  crowd: CrowdExposure | null;
  /** Hour by hour through the day, without the interventions and with them
   * (null with none), and today without them when the year shown is
   * `years` from now (null in the current year); `stale`: another day's,
   * while the right one loads. */
  curve: {
    current: HourComfort[];
    planned: HourComfort[] | null;
    today: HourComfort[] | null;
    years: number;
    stale: boolean;
  } | null;
}

const LEGEND_MIN = FELT_STOPS[0][0];
const LEGEND_MAX = FELT_STOPS[FELT_STOPS.length - 1][0];
const position = (celsius: number) => (100 * (celsius - LEGEND_MIN)) / (LEGEND_MAX - LEGEND_MIN);
const GRADIENT = `linear-gradient(to right, ${FELT_STOPS.map(([c, hex]) => `${hex} ${position(c).toFixed(1)}%`).join(", ")})`;
// The stress bands' edges, in °C: labelled in the unit shown.
const TICKS = [-13, 0, 9, 26, 32, 38, 46];

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function band(celsius: number): string {
  const found = STRESS_BANDS.find((b) => (b.from === null || celsius >= b.from) && (b.to === null || celsius < b.to));
  return found ? tr(...found.label) : "";
}

/** "40% · 12": a share of a group, and how many people that is. */
function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((100 * part) / whole)}% · ${part}` : "–";
}

/** People in heat stress, or in cold stress — whichever there is (heat when
 * neither): a crowd is seldom in both at once. */
function CrowdStress({ crowd }: { crowd: CrowdExposure }) {
  const kind = crowd.all.cold > crowd.all.heat ? "cold" : "heat";
  const of = (group: GroupExposure) => share(kind === "cold" ? group.cold : group.heat, group.people);
  return (
    <>
      <div className="thermal-panel__row">
        <span>{kind === "cold" ? tr("In stress da freddo", "In cold stress") : tr("In stress da caldo", "In heat stress")}</span>
        <span>{of(crowd.all)}</span>
      </div>
      <div className="thermal-panel__row thermal-panel__row--detail">
        <span>
          {tr("ferme", "stopping")} {of(crowd.stopping)}, {tr("in cammino", "walking")} {of(crowd.walking)}
        </span>
      </div>
      {crowd.shortfall && (
        <div
          className="thermal-panel__row"
          title={tr(
            "Delle persone che passerebbero di qui con un clima confortevole, quante rinunciano per il caldo o il freddo e vanno altrove",
            "Of the people who would pass through here in comfortable weather, how many give up because of the heat or cold and go elsewhere"
          )}
        >
          <span>{tr("Rinunciano a passare", "Give up passing")}</span>
          <span>{Math.round(100 * (1 - crowd.shortfall.pass))}%</span>
        </div>
      )}
      {crowd.shortfall && crowd.shortfall.wouldStop > 0 && (
        <div
          className="thermal-panel__row"
          title={tr(
            "Delle persone che si fermerebbero qui con un clima confortevole, quante rinunciano per il caldo o il freddo e vanno altrove",
            "Of the people who would stop here in comfortable weather, how many give up because of the heat or cold and go elsewhere"
          )}
        >
          <span>{tr("Rinunciano a fermarsi", "Give up stopping")}</span>
          <span>
            {/* A share only: the counts behind it are expected values, before
                the cap on how many stop, so they don't match the people shown. */}
            {Math.round(100 * Math.max(0, 1 - crowd.shortfall.stop / crowd.shortfall.wouldStop))}%
          </span>
        </div>
      )}
    </>
  );
}

function LegendLine({ variant, label }: { variant: string; label: string }) {
  return (
    <span>
      <svg width="18" height="6" aria-hidden="true">
        <line x1="0" x2="18" y1="3" y2="3" className={`chart__line chart__line--${variant}`} />
      </svg>
      {label}
    </span>
  );
}

function CurveLegend({ curve }: { curve: NonNullable<Props["curve"]> }) {
  const later = curve.today
    ? tr(`Tra ${curve.years} ${curve.years === 1 ? "anno" : "anni"}`, `In ${curve.years} ${curve.years === 1 ? "year" : "years"}`)
    : null;
  return (
    <div className="daily-chart__legend">
      {curve.today && <LegendLine variant="today" label={tr("Oggi", "Today")} />}
      <LegendLine
        variant={curve.planned ? "baseline" : "only"}
        label={
          later
            ? curve.planned
              ? tr(`${later}, senza proposte`, `${later}, without the proposals`)
              : later
            : tr("Situazione attuale", "Current situation")
        }
      />
      {curve.planned && (
        <LegendLine
          variant="scenario"
          label={later ? tr(`${later}, con le proposte`, `${later}, with the proposals`) : tr("Con le proposte", "With the proposals")}
        />
      )}
    </div>
  );
}

/** A temperature in °C, in the unit shown. */
function celsius(value: number): string {
  return `${fromCelsius(value).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${tempSymbol()}`;
}

/** Felt temperature: a panel with the hour's figures over the open space
 * and, in the 3D view, for the people in it; the day hour by hour; and,
 * when the field is drawn on the ground, the value under the pointer and
 * the colour scale. Opening the panel and drawing the field are separate
 * switches. */
export function ThermalPanel({
  open,
  onOpenChange,
  fieldShown,
  onFieldShownChange,
  field,
  loading,
  failed,
  hour,
  onHourChange,
  reading,
  crowd,
  curve,
}: Props) {
  return (
    <div className="thermal-panel">
      <div className="thermal-panel__head">
        <button
          type="button"
          className="thermal-panel__title"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          <span className="thermal-panel__chevron">{open ? "▾" : "▸"}</span>
          {tr("Temperatura percepita", "Felt temperature")}
        </button>
        <label
          className="thermal-panel__field-switch"
          title={tr("Disegna la temperatura percepita sul terreno", "Draw the felt temperature on the ground")}
        >
          <input type="checkbox" checked={fieldShown} onChange={(event) => onFieldShownChange(event.target.checked)} />
          <span>{tr("Mappa", "Map")}</span>
        </label>
      </div>
      {open && (
        <>
          {failed ? (
            <p className="thermal-panel__note">{tr("Impossibile calcolare la mappa.", "Could not compute the map.")}</p>
          ) : !field ? (
            <p className="thermal-panel__note">{tr("Calcolo in corso…", "Computing…")}</p>
          ) : (
            <>
              <p className="thermal-panel__when">
                {formatDate(new Date(field.date))}, {tr("ore", "at")} {formatHour(hour)}
                {loading && <span className="thermal-panel__busy"> · {tr("aggiorno…", "updating…")}</span>}
              </p>
              <div className="thermal-panel__row">
                <span>{tr("Aria", "Air")}</span>
                <span>{celsius(summaryAt(field.airTemperature, hour))}</span>
              </div>
              <div className="thermal-panel__row">
                <span>{tr("Percepita, media", "Felt, mean")}</span>
                <span>{celsius(summaryAt(field.meanFelt, hour))}</span>
              </div>
              <div className="thermal-panel__row">
                <span>{tr("Area in stress da caldo", "Area in heat stress")}</span>
                <span>{Math.round(summaryAt(field.heatStressPct, hour))}%</span>
              </div>
              {fieldShown && (
                <div className="thermal-panel__row thermal-panel__row--pointer">
                  <span>{reading?.where === "here" ? tr("Dove sei", "Where you are") : tr("Al puntatore", "At the pointer")}</span>
                  <span>{reading === null ? "–" : `${celsius(reading.celsius)} · ${band(reading.celsius)}`}</span>
                </div>
              )}
              {crowd && crowd.all.meanFelt !== null && (
                <>
                  <p className="thermal-panel__section">{tr("Persone nella piazza:", "People in the square:")} {crowd.all.people}</p>
                  <div className="thermal-panel__row">
                    <span>{tr("Percepita, media", "Felt, mean")}</span>
                    <span>{celsius(crowd.all.meanFelt)}</span>
                  </div>
                  <CrowdStress crowd={crowd} />
                </>
              )}
            </>
          )}
          {curve && (
            <>
              <p className="thermal-panel__section">{tr("Nella giornata", "Through the day")}</p>
              <DailyChart
                title={tr("In stress termico", "In thermal stress")}
                current={curve.current.map((h) => h.stressed)}
                planned={curve.planned?.map((h) => h.stressed) ?? null}
                today={curve.today?.map((h) => h.stressed) ?? null}
                hour={hour}
                onHourChange={onHourChange}
                stale={curve.stale}
              />
              <DailyChart
                title={tr("Persone in meno", "Fewer people")}
                current={curve.current.map((h) => h.missing)}
                planned={curve.planned?.map((h) => h.missing) ?? null}
                today={curve.today?.map((h) => h.missing) ?? null}
                hour={hour}
                onHourChange={onHourChange}
                stale={curve.stale}
              />
              {(curve.planned || curve.today) && <CurveLegend curve={curve} />}
            </>
          )}
          {fieldShown && (
            <>
              <div className="thermal-panel__scale" style={{ background: GRADIENT }} />
              <div className="thermal-panel__ticks">
                {TICKS.map((tick) => (
                  <span key={tick} style={{ left: `${position(tick)}%` }}>
                    {Math.round(fromCelsius(tick))}
                  </span>
                ))}
              </div>
              <div className="thermal-panel__ends">
                <span>← {tr("freddo", "cold")}</span>
                <span>{tempSymbol()}</span>
                <span>{tr("caldo", "hot")} →</span>
              </div>
            </>
          )}
          <p className="thermal-panel__note">
            {tr(
              "Indicativa: sole e ombra, suolo e verde; senza vento. Giornata serena tipica.",
              "Indicative: sun and shade, ground and greenery; no wind. A typical clear day."
            )}
          </p>
        </>
      )}
    </div>
  );
}
