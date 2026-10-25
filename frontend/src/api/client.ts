import type {
  AuthInfo,
  BaselineScene,
  CardSpec,
  DeferredIndicators,
  IndicatorDescriptors,
  IndicatorSeries,
  Intervention,
  InterventionCreate,
  LoginResponse,
  Me,
  ScenarioInfo,
  SceneResponse,
  SiteAsset,
  SiteAssets,
  TerrainGrid,
  ThermalFieldResponse,
} from "./types";

// With teams (CIVIC_ENGAGEMENT_AUTH=pin), the token a PIN was exchanged for
// (see civic_engagement/access.py): kept across reloads and tabs, sent on
// every call. Without teams there's none, and none is asked for.
const TOKEN_KEY = "civic-engagement-token";
let onUnauthorised: () => void = () => {};

export function storedToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY);
}

export function forgetToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

/** Called when the backend refuses the token (a PIN changed, a member
 * removed): the app goes back to the PIN screen. */
export function setUnauthorisedHandler(handler: () => void): void {
  onUnauthorised = handler;
}

/** Every call to the API, the pack's too: with the token, if there is one. */
async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const token = storedToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 && token) {
    forgetToken();
    onUnauthorised();
  }
  return res;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await request(url);
  if (!res.ok) throw new HttpError(`GET ${url} failed: ${res.status}`, res.status);
  return res.json();
}

/** How this app is entered: no login, or a PIN. */
export function fetchAuthInfo(): Promise<AuthInfo> {
  return getJson("/api/auth/info");
}

/** Who this window is, with its token. */
export function fetchMe(): Promise<Me> {
  return getJson("/api/auth/me");
}

/** Thrown by `loginWithPin` after too many attempts: retry after `seconds`. */
export class TooManyAttemptsError extends Error {
  readonly seconds: number;

  constructor(seconds: number) {
    super(`Too many attempts: retry in ${seconds} s`);
    this.seconds = seconds;
  }
}

/** The PIN for a token, kept for the next calls; null for a PIN that isn't one. */
export async function loginWithPin(pin: string): Promise<LoginResponse | null> {
  const res = await fetch("/api/auth/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  if (res.status === 401) return null;
  if (res.status === 429) throw new TooManyAttemptsError(Number(res.headers.get("Retry-After") ?? "60"));
  if (!res.ok) throw new HttpError(`POST /api/auth/pin failed: ${res.status}`, res.status);
  const login: LoginResponse = await res.json();
  window.localStorage.setItem(TOKEN_KEY, login.token);
  return login;
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

export function fetchSiteAssets(): Promise<SiteAssets> {
  return getJson("/api/site-assets");
}

/** The terrain grid listed in the site's assets; asked for by version, so
 * the browser keeps it. */
export function fetchTerrainGrid(asset: SiteAsset): Promise<TerrainGrid> {
  return getJson(`/api/site-assets/${asset.key}?v=${asset.version}`);
}

export function fetchIndicatorDescriptors(): Promise<IndicatorDescriptors> {
  return getJson("/api/indicators/descriptors");
}

/** Apart from the scene, which would otherwise wait for them (two fields,
 * for the thermal ones). */
export function fetchDeferredIndicators(t: number): Promise<DeferredIndicators> {
  return getJson(`/api/indicators/deferred?t=${t}`);
}

export function fetchIndicatorSeries(): Promise<IndicatorSeries> {
  return getJson("/api/indicators/series");
}

export function fetchThermalField(t: number, month: number, day: number, asIs: boolean): Promise<ThermalFieldResponse> {
  return getJson(`/api/thermal-field?t=${t}&month=${month}&day=${day}${asIs ? "&as_is=true" : ""}`);
}

export async function createIntervention(data: InterventionCreate, t: number = 0): Promise<SceneResponse> {
  const res = await request(`/api/interventions?t=${t}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new HttpError(`POST /api/interventions failed: ${res.status}`, res.status);
  return res.json();
}

/** A failed request, with its HTTP status. */
export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function updateIntervention(
  id: string,
  params: Record<string, unknown>,
  t: number = 0
): Promise<SceneResponse> {
  const res = await request(`/api/interventions/${id}?t=${t}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ params }),
  });
  if (!res.ok) throw new Error(`PATCH /api/interventions/${id} failed: ${res.status}`);
  return res.json();
}

export async function deleteIntervention(id: string, t: number = 0): Promise<SceneResponse> {
  const res = await request(`/api/interventions/${id}?t=${t}`, { method: "DELETE" });
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
  const res = await request("/api/scenarios", {
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
  const res = await request(`/api/scenarios/${encodeURIComponent(id)}/load?t=${t}`, { method: "POST" });
  if (!res.ok) throw new Error(`POST /api/scenarios/${id}/load failed: ${res.status}`);
  return res.json();
}

export async function deleteScenario(id: string): Promise<void> {
  const res = await request(`/api/scenarios/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE /api/scenarios/${id} failed: ${res.status}`);
}

/** No interventions left; returns the scene without them. */
export async function clearSession(t: number = 0): Promise<SceneResponse> {
  const res = await request(`/api/session/clear?t=${t}`, { method: "POST" });
  if (!res.ok) throw new Error(`POST /api/session/clear failed: ${res.status}`);
  return res.json();
}
