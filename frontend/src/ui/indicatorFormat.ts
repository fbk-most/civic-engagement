import type { IndicatorDescriptor, IndicatorValues } from "../api/types";
import { locale, tr } from "../i18n/lang";

/** What the key indicators panel and the "Indicators" tab show of an
 * indicator, read off its descriptor. */

export function indicatorLabel(d: IndicatorDescriptor): string {
  return tr(d.label, d.label_en);
}

export function indicatorShortLabel(d: IndicatorDescriptor): string {
  return d.short_label === null ? indicatorLabel(d) : tr(d.short_label, d.short_label_en ?? d.short_label);
}

export function indicatorUnit(d: IndicatorDescriptor): string {
  return tr(d.unit, d.unit_en ?? d.unit);
}

/** A number indicator's value; null if missing, not computable or not a
 * number. */
export function numberValue(values: IndicatorValues | null | undefined, id: string): number | null {
  const value = values?.[id];
  return typeof value === "number" ? value : null;
}

export function formatNumber(value: number, decimals: number): string {
  return value.toLocaleString(locale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** The change from `reference` to `value`, if it shows at the indicator's
 * decimals, and whether it's an improvement (null: neither way is). */
export function indicatorDelta(
  d: IndicatorDescriptor,
  value: number | null,
  reference: number | null
): { delta: number; improved: boolean | null } | null {
  if (value === null || reference === null) return null;
  const delta = value - reference;
  if (Math.abs(delta) < 5 * 10 ** -(d.decimals + 1)) return null;
  return { delta, improved: d.better === null ? null : d.better === "higher" ? delta > 0 : delta < 0 };
}

export function formatDelta(d: IndicatorDescriptor, delta: number): string {
  return `${delta > 0 ? "+" : ""}${delta.toLocaleString(locale(), { maximumFractionDigits: d.decimals })}`;
}

/** The BEM modifier colouring a delta: `${block}__delta--better` / `--worse`. */
export function deltaClass(block: string, improved: boolean | null): string {
  const base = `${block}__delta`;
  return improved === null ? base : `${base} ${base}--${improved ? "better" : "worse"}`;
}
