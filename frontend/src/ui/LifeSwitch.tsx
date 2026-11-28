import type { LifeMode } from "../three/people/activity";
import { tr } from "../i18n/lang";

const LIFE_LABELS: Record<LifeMode, { label: () => string; title: () => string }> = {
  off: {
    label: () => tr("Nascosti", "Hidden"),
    title: () => tr("Solo lo spazio, senza persone, animali e auto", "Only the space, without people, animals and cars"),
  },
  still: {
    label: () => tr("Fermi", "Still"),
    title: () => tr("Persone e traffico fermi, come in una fotografia", "People and traffic stopped, as in a photograph"),
  },
  live: {
    label: () => tr("In movimento", "Moving"),
    title: () => tr("Persone che camminano e auto che circolano", "People walking and cars driving around"),
  },
};

/** People and traffic in the 3D view: hidden, still or moving. */
export function LifeSwitch({ mode, onChange }: { mode: LifeMode; onChange: (mode: LifeMode) => void }) {
  return (
    <div className="view-3d__life" role="group" aria-label={tr("Persone e traffico", "People and traffic")}>
      <span>{tr("Persone e traffico", "People and traffic")}</span>
      <div>
        {(Object.keys(LIFE_LABELS) as LifeMode[]).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            title={LIFE_LABELS[option].title()}
            onClick={() => onChange(option)}
          >
            {LIFE_LABELS[option].label()}
          </button>
        ))}
      </div>
    </div>
  );
}
