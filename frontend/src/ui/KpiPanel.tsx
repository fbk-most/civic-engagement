import { useState } from "react";
import type { Indicators, ThermalIndicators } from "../api/types";
import { locale, tr } from "../i18n/lang";

interface Props {
  indicators: Indicators;
  baselineIndicators: Indicators;
  /** Fetched apart from the scene; null until it arrives. */
  thermal: ThermalIndicators | null;
  /** "Situazione attuale": the current values only, no deltas and no costs. */
  asIs: boolean;
  initiallyCollapsed?: boolean;
}

// Cover types counted as "green" ground. Tree canopy isn't a cover type (it
// overhangs whatever ground is below it), so it doesn't count here — hence
// "Superficie verde", not "Copertura arborea".
const GREEN_COVER_TYPES = ["lawn", "meadow", "wood"];

function greenPct(indicators: Indicators): number {
  return GREEN_COVER_TYPES.reduce((sum, type) => sum + (indicators.space_use_pct[type] ?? 0), 0);
}

function KpiRow({
  label,
  value,
  baseline,
  unit,
  decimals,
  betterWhen,
}: {
  label: string;
  /** Null while it's still on its way. */
  value: number | null;
  baseline: number | null;
  unit: string;
  decimals: number;
  /** Which way a change counts as an improvement, for the delta's colour. */
  betterWhen: "higher" | "lower";
}) {
  const delta = baseline === null || value === null ? 0 : value - baseline;
  const changed = Math.abs(delta) >= 5 * 10 ** -(decimals + 1);
  const improved = betterWhen === "higher" ? delta > 0 : delta < 0;
  return (
    <div className="kpi-panel__row">
      <span className="kpi-panel__label">{label}</span>
      <span className="kpi-panel__value">
        {value === null
          ? "…"
          : `${value.toLocaleString(locale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${unit}`}
      </span>
      {changed && (
        <span className={improved ? "kpi-panel__delta kpi-panel__delta--better" : "kpi-panel__delta kpi-panel__delta--worse"}>
          {delta > 0 ? "+" : ""}
          {delta.toLocaleString(locale(), { maximumFractionDigits: decimals })}
        </span>
      )}
    </div>
  );
}

/** The handful of headline indicators kept on screen over the 2D and 3D
 * views; the full set lives in the "Indicatori" tab. Deltas are against the
 * current situation (no interventions) at the same year — except in the
 * current situation itself, which shows its own values alone. */
export function KpiPanel({ indicators, baselineIndicators, thermal, asIs, initiallyCollapsed = false }: Props) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const shown = asIs ? baselineIndicators : indicators;
  const compared = asIs ? null : baselineIndicators;
  const shownThermal = asIs ? thermal?.baseline : thermal?.scenario;

  return (
    <div className="kpi-panel">
      <button type="button" className="panel-header" onClick={() => setCollapsed((c) => !c)}>
        <h3>{tr("Indicatori chiave", "Key indicators")}</h3>
        <span className="panel-header__chevron">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <>
          <KpiRow
            label={tr("Temp. percepita, 21/6 ore 11", "Felt temp., 21 June 11:00")}
            value={shownThermal?.felt_temperature_c ?? null}
            baseline={compared && thermal ? thermal.baseline.felt_temperature_c : null}
            unit=" °C"
            decimals={1}
            betterWhen="lower"
          />
          <KpiRow
            label={tr("Superficie verde", "Green surface")}
            value={greenPct(shown)}
            baseline={compared && greenPct(compared)}
            unit="%"
            decimals={1}
            betterWhen="higher"
          />
          <KpiRow
            label={tr("CO₂ assorbita", "CO₂ absorbed")}
            value={shown.co2.annual_rate_kg}
            baseline={compared && compared.co2.annual_rate_kg}
            unit={tr(" kg/anno", " kg/year")}
            decimals={0}
            betterWhen="higher"
          />
          {!asIs && (
            <>
              <KpiRow
                label={tr("Costo interventi", "Cost of interventions")}
                value={indicators.cost_eur}
                baseline={null}
                unit=" €"
                decimals={0}
                betterWhen="lower"
              />
              <KpiRow
                label={tr("Manutenzione aggiuntiva", "Added maintenance")}
                value={indicators.maintenance.annual_eur}
                baseline={null}
                unit={tr(" €/anno", " €/year")}
                decimals={0}
                betterWhen="lower"
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
