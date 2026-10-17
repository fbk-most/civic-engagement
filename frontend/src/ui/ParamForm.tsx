import { useState } from "react";
import type { CardSpec } from "../api/types";
import { tr } from "../i18n/lang";
import { cardLabel, optionLabel, paramLabel, yearLabel } from "../i18n/labels";

interface Props {
  card: CardSpec;
  initialValues?: Record<string, unknown>;
  submitLabel?: string;
  /** The timeline year this intervention takes effect from — the year
   * being previewed right now for a new card (this is what will become its
   * `planted_year`), or the stored `planted_year` when editing an existing
   * one. Shown so it's never a surprise that something doesn't appear
   * before this point. */
  plantedYear?: number;
  onSubmit: (params: Record<string, unknown>) => void;
  onCancel: () => void;
  onDelete?: () => void;
}

export function ParamForm({
  card,
  initialValues,
  submitLabel = tr("Posiziona", "Place"),
  plantedYear,
  onSubmit,
  onCancel,
  onDelete,
}: Props) {
  const [values, setValues] = useState<Record<string, unknown>>(
    () => initialValues ?? Object.fromEntries(card.params.map((p) => [p.key, p.default]))
  );

  return (
    <form
      className="param-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(values);
      }}
    >
      <h3>{cardLabel(card)}</h3>
      {plantedYear !== undefined && (
        <p className="param-form__planted-year">
          {initialValues ? tr("In vigore da: ", "In effect from: ") : tr("Entrerà in vigore: ", "Takes effect: ")}
          <strong>{yearLabel(plantedYear)}</strong>
        </p>
      )}
      {card.params.map((param) => (
        <label key={param.key} className="param-form__field">
          {paramLabel(param)}
          {param.type === "select" ? (
            <select
              value={values[param.key] as string}
              onChange={(e) => setValues((v) => ({ ...v, [param.key]: e.target.value }))}
            >
              {param.options?.map((opt) => (
                <option key={opt} value={opt}>
                  {optionLabel(param.key, opt)}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={param.type === "number" ? "number" : "text"}
              value={values[param.key] as string | number}
              min={param.min ?? undefined}
              max={param.max ?? undefined}
              step={param.type === "number" ? 0.1 : undefined}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  [param.key]: param.type === "number" ? e.target.valueAsNumber : e.target.value,
                }))
              }
            />
          )}
        </label>
      ))}
      <div className="param-form__actions">
        <button type="submit">{submitLabel}</button>
        <button type="button" onClick={onCancel}>
          {tr("Annulla", "Cancel")}
        </button>
        {onDelete && (
          <button type="button" className="param-form__delete" onClick={onDelete}>
            {tr("Elimina", "Delete")}
          </button>
        )}
      </div>
    </form>
  );
}
