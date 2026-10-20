import { setTempUnit, type TempUnit } from "../i18n/units";

const UNITS: { value: TempUnit; label: string; title: string }[] = [
  { value: "C", label: "°C", title: "Celsius" },
  { value: "F", label: "°F", title: "Fahrenheit" },
];

/** The unit temperatures are shown in (see i18n/units.ts); styled as the
 * language switch. */
export function TempSwitch({ unit }: { unit: TempUnit }) {
  return (
    <div className="lang-switch" role="group" aria-label="Unità di temperatura / Temperature unit">
      {UNITS.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          aria-pressed={option.value === unit}
          onClick={() => setTempUnit(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
