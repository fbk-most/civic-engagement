import { useSyncExternalStore } from "react";

// The unit temperatures are shown in. They're computed and served in °C;
// only what's shown converts. Chosen like the language (see lang.ts):
// `?temp=C|F`, else the last choice of the °C/°F switch, else °C. App calls
// `useTempUnit`, so a change re-renders the whole tree.

export type TempUnit = "C" | "F";

const STORAGE_KEY = "civic-twin-temp";

function initialUnit(): TempUnit {
  const fromUrl = new URLSearchParams(window.location.search).get("temp")?.toUpperCase();
  if (fromUrl === "C" || fromUrl === "F") return fromUrl;
  return window.localStorage.getItem(STORAGE_KEY) === "F" ? "F" : "C";
}

let current: TempUnit = initialUnit();
const listeners = new Set<() => void>();

export function getTempUnit(): TempUnit {
  return current;
}

export function setTempUnit(unit: TempUnit): void {
  if (unit === current) return;
  current = unit;
  window.localStorage.setItem(STORAGE_KEY, unit);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTempUnit(): TempUnit {
  return useSyncExternalStore(subscribe, getTempUnit);
}

/** A temperature in °C, in the unit shown. */
export function fromCelsius(celsius: number): number {
  return current === "F" ? (celsius * 9) / 5 + 32 : celsius;
}

/** The unit shown's symbol: "°C" or "°F". */
export function tempSymbol(): string {
  return `°${current}`;
}
