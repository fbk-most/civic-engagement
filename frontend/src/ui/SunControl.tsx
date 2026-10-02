import { daysInMonth, formatHour, SEASON_PRESETS, type SunSetting } from "../three/sun";

const MONTH_LABELS_IT = [
  "Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno",
  "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre",
];

interface SunControlProps {
  setting: SunSetting;
  altitudeDeg: number;
  /** The calendar year the date resolves to (`CURRENT_YEAR + t`) — display
   * only, not editable here: the scenario year comes from `TimeSlider`, this
   * control only ever picks a day of the year and a time of day. */
  year: number;
  onChange: (setting: SunSetting) => void;
}

/** Day and time-of-day for the sun.
 *
 * Deliberately kept visually distinct from the `TimeSlider`, which moves the
 * scenario forward in *years*. The year itself isn't a field here at all —
 * it always follows the scenario slider — so this only ever asks "which day,
 * which hour", labelled with the resulting date so it's never ambiguous
 * which year that day falls in.
 */
export function SunControl({ setting, altitudeDeg, year, onChange }: SunControlProps) {
  const belowHorizon = altitudeDeg <= 0;
  const maxDay = daysInMonth(setting.month, year);

  return (
    <div className="sun-control">
      <div className="sun-control__row">
        <label className="sun-control__field">
          <span className="sun-control__label">Giorno</span>
          <select
            value={setting.month}
            onChange={(event) => {
              const month = Number(event.target.value);
              const day = Math.min(setting.day, daysInMonth(month, year));
              onChange({ ...setting, month, day });
            }}
          >
            {MONTH_LABELS_IT.map((label, i) => (
              <option key={label} value={i + 1}>
                {label}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={maxDay}
            value={setting.day}
            onChange={(event) => {
              const day = event.target.valueAsNumber;
              if (day >= 1 && day <= maxDay) onChange({ ...setting, day });
            }}
          />
          <span className="sun-control__year">{year}</span>
        </label>
        <div className="sun-control__presets">
          {SEASON_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              title={preset.label}
              aria-pressed={setting.month === preset.month && setting.day === preset.day}
              onClick={() => onChange({ ...setting, month: preset.month, day: preset.day })}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sun-control__row">
        <label className="sun-control__field sun-control__field--grow">
          <span className="sun-control__label">Ora</span>
          <input
            type="range"
            min={4}
            max={22}
            step={0.25}
            value={setting.hour}
            onChange={(event) => onChange({ ...setting, hour: Number(event.target.value) })}
          />
        </label>
        <span className="sun-control__readout">
          <strong>{formatHour(setting.hour)}</strong>
          {" · "}
          {belowHorizon
            ? "sole sotto l'orizzonte"
            : `sole a ${Math.round(altitudeDeg)}° sull'orizzonte`}
        </span>
      </div>
    </div>
  );
}
