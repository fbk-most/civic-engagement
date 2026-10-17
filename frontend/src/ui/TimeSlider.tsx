import { tr } from "../i18n/lang";
import { yearLabel } from "../i18n/labels";

const PRESETS = [0, 5, 10, 20, 30] as const;
const MAX_T = 30;

interface Props {
  t: number;
  onChange: (t: number) => void;
  /** Drawn as a row of the 3D view's time panel, alongside day and hour,
   * instead of as its own floating bar. */
  embedded?: boolean;
}

/** A continuous year slider (0..30, one step per year) rather than just the
 * five milestone points — those stay as quick-jump presets alongside it, the
 * same pairing `SunControl` uses for its date field. */
export function TimeSlider({ t, onChange, embedded = false }: Props) {
  return (
    <div className={embedded ? "time-slider time-slider--embedded" : "time-slider"}>
      <span className="time-slider__label">{embedded ? tr("Anno", "Year") : tr("Tempo:", "Time:")}</span>
      <input
        type="range"
        min={0}
        max={MAX_T}
        step={1}
        value={t}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="time-slider__readout">{yearLabel(t)}</span>
      <div className="time-slider__presets">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={preset === t}
            className={preset === t ? "time-slider__preset time-slider__preset--active" : "time-slider__preset"}
            onClick={() => onChange(preset)}
          >
            {yearLabel(preset)}
          </button>
        ))}
      </div>
    </div>
  );
}
