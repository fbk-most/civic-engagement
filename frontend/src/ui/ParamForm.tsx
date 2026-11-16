import { useEffect, useState } from "react";
import type { CardSpec, InterventionCheck, ParamSpec } from "../api/types";
import { optionLabel, yearLabel } from "../i18n/labels";
import { CheckReport } from "./CheckReport";

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
  /** What the backend says about the area just drawn, for a card that clears
   * it (see CheckReport): while it is being asked (`checking`), or its answer.
   * Placing is held until the check is in, refused when something is in the
   * way, and needs a confirmation when there are warnings. */
  check?: InterventionCheck | null;
  checking?: boolean;
  /** Why the backend refused the parameters last submitted. */
  error?: string | null;
  onSubmit: (params: Record<string, unknown>) => void;
  onCancel: () => void;
  onDelete?: () => void;
}

const REPOSITION_LABEL = {
  point: "Scegli un altro punto",
  polyline: "Ridisegna il percorso",
  area: "Ridisegna l'area",
};

function numberProblem(param: ParamSpec, value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Inserisci un numero";
  if (param.min !== null && value < param.min) return `Minimo: ${param.min}`;
  if (param.max !== null && value > param.max) return `Massimo: ${param.max}`;
  return null;
}

export function ParamForm({
  card,
  initialValues,
  submitLabel = "Posiziona",
  plantedYear,
  check = null,
  checking = false,
  error = null,
  onSubmit,
  onCancel,
  onDelete,
}: Props) {
  const [values, setValues] = useState<Record<string, unknown>>(
    () => initialValues ?? Object.fromEntries(card.params.map((p) => [p.key, p.default]))
  );
  const [confirmed, setConfirmed] = useState(false);
  // A new answer is a new thing to confirm.
  useEffect(() => setConfirmed(false), [check]);

  // The same limits the backend enforces (from the spec): an empty or
  // out-of-range number is said here, before anything is sent.
  const fieldErrors = Object.fromEntries(
    card.params
      .filter((p) => p.type === "number")
      .map((p) => [p.key, numberProblem(p, values[p.key])] as const)
      .filter(([, problem]) => problem)
  );
  const invalid = Object.keys(fieldErrors).length > 0;

  const blocked = (check?.blocking.length ?? 0) > 0;
  const needsConfirmation = !blocked && (check?.warnings.length ?? 0) > 0 && !confirmed;

  return (
    <form
      className="param-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(values);
      }}
    >
      <h3>{card.label}</h3>
      {plantedYear !== undefined && (
        <p className="param-form__planted-year">
          {initialValues ? "In vigore da: " : "Entrerà in vigore: "}
          <strong>{yearLabel(plantedYear)}</strong>
        </p>
      )}
      {card.params.map((param) => (
        <label key={param.key} className="param-form__field">
          {param.label}
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
          {fieldErrors[param.key] && (
            <span className="param-form__error" role="alert">
              {fieldErrors[param.key]}
            </span>
          )}
        </label>
      ))}
      {error && (
        <p className="param-form__error" role="alert">
          {error}
        </p>
      )}
      <CheckReport check={check} checking={checking} confirmed={confirmed} onConfirmedChange={setConfirmed} />
      <div className="param-form__actions">
        {blocked ? (
          <button type="button" className="param-form__redraw" onClick={onCancel}>
            {REPOSITION_LABEL[card.placement_type]}
          </button>
        ) : (
          <>
            <button type="submit" disabled={checking || needsConfirmation || invalid}>
              {submitLabel}
            </button>
            <button type="button" onClick={onCancel}>
              Annulla
            </button>
          </>
        )}
        {onDelete && (
          <button type="button" className="param-form__delete" onClick={onDelete}>
            Elimina
          </button>
        )}
      </div>
    </form>
  );
}
