import { useSyncExternalStore } from "react";

// The interface language. Every text is written in place as an Italian /
// English pair, `tr("Anno", "Year")`, read in the current language: a
// component that calls `tr` while rendering re-renders on a change because
// App (which calls `useLang`) does, and nothing below it is memoised. Code
// that draws text outside React (the 3D placards) takes the language as an
// input and redraws on a change.

export type Lang = "it" | "en";

const STORAGE_KEY = "civic-twin-lang";

function initialLang(): Lang {
  const fromUrl = new URLSearchParams(window.location.search).get("lang");
  if (fromUrl === "it" || fromUrl === "en") return fromUrl;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "it" ? "it" : "en";
}

let current: Lang = initialLang();
document.documentElement.lang = current;
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  window.localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.lang = lang;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang);
}

/** The text in the current language. */
export function tr(it: string, en: string): string {
  return current === "en" ? en : it;
}

/** Number formatting for the current language (decimal comma in Italian). */
export function locale(): string {
  return current === "en" ? "en-GB" : "it-IT";
}
