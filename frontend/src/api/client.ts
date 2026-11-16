import type {
  BaselineScene,
  CardSpec,
  IndicatorSeries,
  Intervention,
  InterventionCheck,
  InterventionCreate,
  SceneResponse,
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

export function fetchIndicatorSeries(): Promise<IndicatorSeries> {
  return getJson("/api/indicators/series");
}

/** A placement the backend refused because something protected is under it
 * (a 409 carrying the same answer as the check): what is in the way. */
export class InterventionBlockedError extends Error {
  readonly check: InterventionCheck;

  constructor(check: InterventionCheck) {
    super("Placement refused: something protected is under the area");
    this.check = check;
  }
}

/** A request the backend refused as invalid (422): `message` is its own
 * explanation of what is wrong with the parameters, fit to show the user. */
export class InvalidParamsError extends Error {}

async function failIfInvalid(res: Response): Promise<void> {
  if (res.status !== 422) return;
  const body = await res.json().catch(() => null);
  if (typeof body?.detail === "string") throw new InvalidParamsError(body.detail);
}

export async function checkIntervention(data: InterventionCreate, t: number = 0): Promise<InterventionCheck> {
  const res = await fetch(`/api/interventions/check?t=${t}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`POST /api/interventions/check failed: ${res.status}`);
  return res.json();
}

export async function createIntervention(data: InterventionCreate, t: number = 0): Promise<SceneResponse> {
  const res = await fetch(`/api/interventions?t=${t}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    if (Array.isArray(body?.detail?.blocking)) throw new InterventionBlockedError(body.detail);
  }
  await failIfInvalid(res);
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
  await failIfInvalid(res);
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
