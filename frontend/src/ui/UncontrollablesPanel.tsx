import { useState } from "react";
import type { Uncontrollables, UncontrollableSpec } from "../api/types";
import { tr } from "../i18n/lang";
import { uncontrollableLabel, uncontrollableValueLabel } from "../i18n/labels";

interface Props {
  specs: UncontrollableSpec[];
  /** The scene's: every one's value (or those just picked, while busy). */
  values: Uncontrollables;
  /** The scene under the values just picked is on its way: no change meanwhile. */
  busy?: boolean;
  /** Viewers see the values, without changing them. */
  canEdit: boolean;
  onChange: (values: Uncontrollables) => void;
  initiallyCollapsed?: boolean;
}

/** The pack's uncontrollables (see civic_engagement/domain.py): what the
 * team's scenario assumes but nobody at the table decides. The current
 * situation the indicators compare with is computed under the same values,
 * so that the differences are the cards' alone. The values are the team's,
 * like its cards: a change shows in every window of the team. */
export function UncontrollablesPanel({ specs, values, busy = false, canEdit, onChange, initiallyCollapsed = false }: Props) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  return (
    <div className="uncontrollables-panel">
      <button type="button" className="panel-header" onClick={() => setCollapsed((c) => !c)}>
        <h3>{tr("Condizioni esterne", "External conditions")}</h3>
        <span className="panel-header__chevron">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <>
          {specs.map((spec) => (
            <label key={spec.id} className="uncontrollables-panel__row">
              <span className="uncontrollables-panel__label">{uncontrollableLabel(spec)}</span>
              {canEdit ? (
                <select
                  value={values[spec.id] ?? spec.default}
                  disabled={busy}
                  onChange={(e) => onChange({ ...values, [spec.id]: e.target.value })}
                >
                  {spec.values.map((v) => (
                    <option key={v.id} value={v.id}>
                      {tr(v.label, v.label_en)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="uncontrollables-panel__value">{uncontrollableValueLabel(spec, values[spec.id])}</span>
              )}
            </label>
          ))}
          {busy && <p className="uncontrollables-panel__busy">{tr("Calcolo in corso…", "Computing…")}</p>}
          <p className="uncontrollables-panel__note">
            {tr(
              "Non dipendono dalle carte; anche la situazione attuale è calcolata con queste condizioni.",
              "They don't depend on the cards; the current situation is computed under these conditions too."
            )}
          </p>
        </>
      )}
    </div>
  );
}
