import { useState } from "react";
import type { CardSpec, ParamSpec } from "../api/types";
import { locale, tr } from "../i18n/lang";
import { authorsLabel, cardLabel, optionLabel, paramLabel, yearLabel } from "../i18n/labels";

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
  /** An existing card's authors, with teams. */
  authors?: { created_by?: string | null; updated_by?: string | null };
  /** The pack's words on what the card took or does ([Italian, English]). */
  summary?: [string, string];
  onSubmit: (params: Record<string, unknown>) => void;
  onCancel: () => void;
  onDelete?: () => void;
}

export function ParamForm({
  card,
  initialValues,
  submitLabel = tr("Posiziona", "Place"),
  plantedYear,
  authors,
  summary,
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
      {authors && authorsLabel(authors) && <p className="param-form__authors">{authorsLabel(authors)}</p>}
      {summary && <p className="param-form__summary">{tr(...summary)}</p>}
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
              required={param.type === "number"}
              // The browser checks the bounds before the form is sent, in
              // its own language: the message is the interface's instead.
              onInvalid={(e) => e.currentTarget.setCustomValidity(invalidNumber(param, e.currentTarget.validity))}
              onChange={(e) => {
                e.target.setCustomValidity("");
                setValues((v) => ({
                  ...v,
                  [param.key]: param.type === "number" ? e.target.valueAsNumber : e.target.value,
                }));
              }}
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

/** Why a number field's value can't be sent, in the interface's language. */
function invalidNumber(param: ParamSpec, validity: ValidityState): string {
  // With the interface's decimal separator ("0,5" in Italian).
  const bound = (value: number | null | undefined) => (value ?? 0).toLocaleString(locale());
  if (validity.rangeUnderflow) return tr(`Il valore minimo è ${bound(param.min)}.`, `The minimum is ${bound(param.min)}.`);
  if (validity.rangeOverflow) return tr(`Il valore massimo è ${bound(param.max)}.`, `The maximum is ${bound(param.max)}.`);
  if (validity.stepMismatch) return tr("Al più un decimale.", "At most one decimal.");
  return tr("Inserisci un numero.", "Enter a number.");
}
