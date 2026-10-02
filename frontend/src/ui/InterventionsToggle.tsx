import type { InterventionDisplayMode } from "../api/types";

interface Props {
  mode: InterventionDisplayMode;
  onChange: (mode: InterventionDisplayMode) => void;
}

const MODES: { value: InterventionDisplayMode; label: string }[] = [
  { value: "hidden", label: "Situazione attuale" },
  { value: "cards", label: "Carte proposte" },
  { value: "simulated", label: "Simulazione" },
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
          {option.label}
        </button>
      ))}
    </div>
  );
}
