import { setLang, type Lang } from "../i18n/lang";

const LANGS: { value: Lang; label: string; title: string }[] = [
  { value: "it", label: "IT", title: "Italiano" },
  { value: "en", label: "EN", title: "English" },
];

/** The interface language (see i18n/lang.ts). */
export function LangSwitch({ lang }: { lang: Lang }) {
  return (
    <div className="lang-switch" role="group" aria-label="Lingua / Language">
      {LANGS.map((option) => (
        <button
          key={option.value}
          type="button"
          lang={option.value}
          title={option.title}
          aria-pressed={option.value === lang}
          onClick={() => setLang(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
