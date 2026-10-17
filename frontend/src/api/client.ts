import type {
  BaselineScene,
  CardSpec,
  IndicatorSeries,
  Intervention,
  InterventionCreate,
  ScenarioInfo,
  SceneResponse,
  ThermalFieldResponse,
  ThermalIndicators,
} from "./types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json();
}

export function fetchBaseline(): Promise<BaselineScene> {
  return getJson("/api/baseline");
}

export function fetchCards(): Promise<CardSpec[]> {
  return getJson("/api/cards");
}

export function fetchScene(t: number = 0): Promise<SceneResponse> {
  return getJson(`/api/scene?t=${t}`);
}

/** Changes whenever any window changes the session's interventions. */
export function fetchSessionRevision(): Promise<{ revision: string }> {
  return getJson("/api/session/revision");
}

/** Apart from the scene, which would otherwise wait for their two fields. */
export function fetchThermalIndicators(t: number): Promise<ThermalIndicators> {
  return getJson(`/api/indicators/thermal?t=${t}`);
}

export function fetchIndicatorSeries(): Promise<IndicatorSeries> {
  return getJson("/api/indicators/series");
}

export function fetchThermalField(t: number, month: number, day: number, asIs: boolean): Promise<ThermalFieldResponse> {
  return getJson(`/api/thermal-field?t=${t}&month=${month}&day=${day}${asIs ? "&as_is=true" : ""}`);
}

export async function createIntervention(data: InterventionCreate, t: number = 0): Promise<SceneResponse> {
  const res = await fetch(`/api/interventions?t=${t}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`POST /api/interventions failed: ${res.status}`);
  return res.json();
}

export async function updateIntervention(
  id: string,
  params: Record<string, unknown>,
  t: number = 0
): Promise<SceneResponse> {
  const res = await fetch(`/api/interventions/${id}?t=${t}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ params }),
  });
  if (!res.ok) throw new Error(`PATCH /api/interventions/${id} failed: ${res.status}`);
  return res.json();
}

export async function deleteIntervention(id: string, t: number = 0): Promise<SceneResponse> {
  const res = await fetch(`/api/interventions/${id}?t=${t}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE /api/interventions/${id} failed: ${res.status}`);
  return res.json();
}

export function fetchInterventions(): Promise<Intervention[]> {
  return getJson("/api/interventions");
}

export function fetchScenarios(): Promise<ScenarioInfo[]> {
  return getJson("/api/scenarios");
}

/** Thrown by `saveScenario` when a scenario with that name exists and
 * `overwrite` wasn't set. */
export class ScenarioExistsError extends Error {}

export async function saveScenario(name: string, overwrite: boolean): Promise<ScenarioInfo> {
  const res = await fetch("/api/scenarios", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, overwrite }),
  });
  if (res.status === 409) throw new ScenarioExistsError(name);
  if (!res.ok) throw new Error(`POST /api/scenarios failed: ${res.status}`);
  return res.json();
}

/** The session becomes the scenario; returns the scene with it. */
export async function loadScenario(id: string, t: number = 0): Promise<SceneResponse> {
  const res = await fetch(`/api/scenarios/${encodeURIComponent(id)}/load?t=${t}`, { method: "POST" });
  if (!res.ok) throw new Error(`POST /api/scenarios/${id}/load failed: ${res.status}`);
  return res.json();
}

export async function deleteScenario(id: string): Promise<void> {
  const res = await fetch(`/api/scenarios/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE /api/scenarios/${id} failed: ${res.status}`);
}

/** No interventions left; returns the scene without them. */
export async function clearSession(t: number = 0): Promise<SceneResponse> {
  const res = await fetch(`/api/session/clear?t=${t}`, { method: "POST" });
  if (!res.ok) throw new Error(`POST /api/session/clear failed: ${res.status}`);
  return res.json();
}
