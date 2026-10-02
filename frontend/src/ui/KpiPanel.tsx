import { useState } from "react";
import type { Indicators } from "../api/types";

interface Props {
  indicators: Indicators;
  baselineIndicators: Indicators;
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
  value: number;
  baseline: number | null;
  unit: string;
  decimals: number;
  /** Which way a change counts as an improvement, for the delta's colour. */
  betterWhen: "higher" | "lower";
}) {
  const delta = baseline === null ? 0 : value - baseline;
  const changed = Math.abs(delta) >= 5 * 10 ** -(decimals + 1);
  const improved = betterWhen === "higher" ? delta > 0 : delta < 0;
  return (
    <div className="kpi-panel__row">
      <span className="kpi-panel__label">{label}</span>
      <span className="kpi-panel__value">
        {value.toLocaleString("it-IT", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
        {unit}
      </span>
      {changed && (
        <span className={improved ? "kpi-panel__delta kpi-panel__delta--better" : "kpi-panel__delta kpi-panel__delta--worse"}>
          {delta > 0 ? "+" : ""}
          {delta.toLocaleString("it-IT", { maximumFractionDigits: decimals })}
        </span>
      )}
    </div>
  );
}

/** The handful of headline indicators kept on screen over the 2D and 3D
 * views; the full set lives in the "Indicatori" tab. Deltas are against the
 * current situation (no interventions) at the same year. */
export function KpiPanel({ indicators, baselineIndicators }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="kpi-panel">
      <button type="button" className="panel-header" onClick={() => setCollapsed((c) => !c)}>
        <h3>Indicatori chiave</h3>
        <span className="panel-header__chevron">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <>
          <KpiRow
            label="Temperatura estiva"
            value={indicators.thermal_comfort.estimated_temperature_c}
            baseline={baselineIndicators.thermal_comfort.estimated_temperature_c}
            unit=" °C"
            decimals={1}
            betterWhen="lower"
          />
          <KpiRow
            label="Superficie verde"
            value={greenPct(indicators)}
            baseline={greenPct(baselineIndicators)}
            unit="%"
            decimals={1}
            betterWhen="higher"
          />
          <KpiRow
            label="CO₂ assorbita"
            value={indicators.co2.annual_rate_kg}
            baseline={baselineIndicators.co2.annual_rate_kg}
            unit=" kg/anno"
            decimals={0}
            betterWhen="higher"
          />
          <KpiRow
            label="Costo interventi"
            value={indicators.cost_eur}
            baseline={null}
            unit=" €"
            decimals={0}
            betterWhen="lower"
          />
        </>
      )}
    </div>
  );
}
