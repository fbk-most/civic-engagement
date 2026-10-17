import { useState } from "react";
import type { DeferredIndicators, IndicatorDescriptor, IndicatorDescriptors, IndicatorValues } from "../api/types";
import { tr } from "../i18n/lang";
import {
  deltaClass,
  formatDelta,
  formatNumber,
  indicatorDelta,
  indicatorShortLabel,
  indicatorUnit,
  numberValue,
} from "./indicatorFormat";

interface Props {
  descriptors: IndicatorDescriptors;
  indicators: IndicatorValues;
  baselineIndicators: IndicatorValues;
  /** Fetched apart from the scene; null until it arrives. */
  deferred: DeferredIndicators | null;
  /** "Situazione attuale": the current values only, no deltas and no costs. */
  asIs: boolean;
  initiallyCollapsed?: boolean;
}

function KpiRow({
  descriptor,
  value,
  baseline,
}: {
  descriptor: IndicatorDescriptor;
  /** Null while it's still on its way. */
  value: number | null;
  baseline: number | null;
}) {
  const change = indicatorDelta(descriptor, value, baseline);
  return (
    <div className="kpi-panel__row">
      <span className="kpi-panel__label">{indicatorShortLabel(descriptor)}</span>
      <span className="kpi-panel__value">
        {value === null ? "…" : `${formatNumber(value, descriptor.decimals)}${indicatorUnit(descriptor)}`}
      </span>
      {change && <span className={deltaClass("kpi-panel", change.improved)}>{formatDelta(descriptor, change.delta)}</span>}
    </div>
  );
}

/** The handful of headline indicators kept on screen over the 2D and 3D
 * views (the descriptors marked `key`); the full set lives in the
 * "Indicatori" tab. Deltas are against the current situation (no
 * interventions) at the same year — except in the current situation itself,
 * which shows its own values alone, and without the indicators only
 * meaningful with interventions. */
export function KpiPanel({ descriptors, indicators, baselineIndicators, deferred, asIs, initiallyCollapsed = false }: Props) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const scenario = { ...indicators, ...deferred?.scenario };
  const baseline = { ...baselineIndicators, ...deferred?.baseline };
  const shown = asIs ? baseline : scenario;
  const rows = descriptors.indicators.filter((d) => d.key && d.kind === "number" && !(asIs && d.scenario_only));

  return (
    <div className="kpi-panel">
      <button type="button" className="panel-header" onClick={() => setCollapsed((c) => !c)}>
        <h3>{tr("Indicatori chiave", "Key indicators")}</h3>
        <span className="panel-header__chevron">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed &&
        rows.map((d) => (
          <KpiRow
            key={d.id}
            descriptor={d}
            value={numberValue(shown, d.id)}
            baseline={asIs || d.scenario_only ? null : numberValue(baseline, d.id)}
          />
        ))}
    </div>
  );
}
