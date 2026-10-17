import type { InterventionDisplayMode } from "../api/types";
import { tr } from "../i18n/lang";

interface Props {
  mode: InterventionDisplayMode;
  onChange: (mode: InterventionDisplayMode) => void;
}

const MODES: { value: InterventionDisplayMode; label: [it: string, en: string] }[] = [
  { value: "hidden", label: ["Situazione attuale", "Current situation"] },
  { value: "cards", label: ["Carte proposte", "Proposed cards"] },
  { value: "simulated", label: ["Simulazione", "Simulation"] },
];

export function InterventionsToggle({ mode, onChange }: Props) {
  return (
    <div className="interventions-toggle">
      {MODES.map((option) => (
        <button
          key={option.value}
          type="button"
          className={
            option.value === mode
              ? "interventions-toggle__button interventions-toggle__button--active"
              : "interventions-toggle__button"
          }
          onClick={() => onChange(option.value)}
        >
          {tr(...option.label)}
        </button>
      ))}
    </div>
  );
}
