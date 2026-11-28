import type { ScenarioInfo } from "../api/types";
import { SIDES, type Compared, type Side } from "../comparison";
import { tr } from "../i18n/lang";

interface Props {
  scenarios: ScenarioInfo[];
  compared: Compared;
  onChange: (compared: Compared) => void;
  /** Reads the scenarios again (one saved meanwhile, in another window). */
  onRefresh: () => void;
}

const CURRENT = "";

/** The two scenarios compared, A and B: each the current scene, a saved
 * scenario or a preset. Each letter in its colour, the one of its curves. */
export function ComparisonPicker({ scenarios, compared, onChange, onRefresh }: Props) {
  const saved = scenarios.filter((scenario) => !scenario.preset);
  const presets = scenarios.filter((scenario) => scenario.preset);
  const choose = (side: Side, value: string) => onChange({ ...compared, [side]: value === CURRENT ? null : value });

  return (
    <div className="comparison-picker" role="group" aria-label={tr("Scenari a confronto", "Scenarios compared")}>
      {SIDES.map((side) => (
        <label key={side} className="comparison-picker__side">
          <span className={`comparison-picker__letter comparison-picker__letter--${side}`}>{side.toUpperCase()}</span>
          <select value={compared[side] ?? CURRENT} onFocus={onRefresh} onChange={(event) => choose(side, event.target.value)}>
            <option value={CURRENT}>{tr("Scena corrente", "Current scene")}</option>
            {saved.length > 0 && (
              <optgroup label={tr("Scenari salvati", "Saved scenarios")}>
                {saved.map((scenario) => (
                  <option key={scenario.id} value={scenario.id}>
                    {scenario.name}
                  </option>
                ))}
              </optgroup>
            )}
            {presets.length > 0 && (
              <optgroup label={tr("Scenari di esempio", "Example scenarios")}>
                {presets.map((scenario) => (
                  <option key={scenario.id} value={scenario.id}>
                    {scenario.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
      ))}
    </div>
  );
}
