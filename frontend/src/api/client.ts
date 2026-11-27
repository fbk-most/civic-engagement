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
  NoteChange,
  NoteList,
  Rehearsal,
  ScenarioInfo,
  SceneResponse,
  SiteAsset,
  SiteAssets,
  TerrainGrid,
  ThermalFieldResponse,
  ViewSpec,
} from "./types";

// With teams (CIVIC_ENGAGEMENT_AUTH=pin), the token a PIN was exchanged for
// (see civic_engagement/access.py): kept across reloads and tabs, sent on
// every call. Without teams there's none, and none is asked for.
const TOKEN_KEY = "civic-engagement-token";
let onUnauthorised: () => void = () => {};
let onPhaseRefused: () => void = () => {};
// The start of the 409's detail when the team's phase refuses a change
// (civic_engagement/access.py, PHASE_REFUSED), unlike the other 409s.
const PHASE_REFUSED = "Not allowed in the current phase";

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

/** Called when the team's phase refuses a change: the phase changed since
 * the app last asked (it asks again, and says so). */
export function setPhaseRefusedHandler(handler: () => void): void {
  onPhaseRefused = handler;
}

/** Thrown by any change the team's phase refuses (a 409, see `request`). */
export class PhaseRefusedError extends Error {}

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
  if (res.status === 409) {
    const detail: unknown = await res.clone().json().then((body) => body?.detail, () => null);
    if (typeof detail === "string" && detail.startsWith(PHASE_REFUSED)) {
      onPhaseRefused();
      throw new PhaseRefusedError(detail);
    }
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

/** Calls `listener` when another window of this origin logs in or out
 * (the token changes in the storage they share). */
export function onTokenChange(listener: () => void): () => void {
  const follow = (event: StorageEvent) => {
    if (event.key === TOKEN_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", follow);
  return () => window.removeEventListener("storage", follow);
}

/** The rehearsal page's: the pack's phases and views (404: the rehearsal
 * isn't on). */
export function fetchRehearsal(): Promise<Rehearsal> {
  return getJson("/api/rehearsal");
}

/** The rehearsal page's: the team's phase, set by an editor; the answer,
 * who this is in it. */
export async function setRehearsalPhase(phase: string): Promise<Me> {
  const res = await request("/api/rehearsal/phase", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phase }),
  });
  if (!res.ok) throw new HttpError(`PUT /api/rehearsal/phase failed: ${res.status}`, res.status);
  return res.json();
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

/** The pack's views (see views.ts). */
export function fetchViews(): Promise<ViewSpec[]> {
  return getJson("/api/views");
}

export function fetchScene(t: number = 0): Promise<SceneResponse> {
  return getJson(`/api/scene?t=${t}`);
}

/** Changes whenever any window changes the session's interventions; with
 * `restart_needed`, the app must be started again for changes to be saved;
 * `phase`, the team's (a change: ask `fetchMe` again). */
/** The scene's revision, and the notes' (`notes`): each fetched again
 * only when its own changes. */
export function fetchSessionRevision(): Promise<{
  revision: string;
  notes: string;
  restart_needed: boolean;
  phase: string | null;
}> {
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

/** Turns a card on or off; returns the scene evaluated without those off. */
export async function setInterventionEnabled(id: string, enabled: boolean, t: number = 0): Promise<SceneResponse> {
  const res = await request(`/api/interventions/${id}/enabled?t=${t}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`PATCH /api/interventions/${id}/enabled failed: ${res.status}`);
  return res.json();
}

export async function deleteIntervention(id: string, t: number = 0): Promise<SceneResponse> {
  const res = await request(`/api/interventions/${id}?t=${t}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE /api/interventions/${id} failed: ${res.status}`);
  return res.json();
}

export function fetchNotes(): Promise<NoteList> {
  return getJson("/api/notes");
}

async function changeNotes(method: string, url: string, body?: object): Promise<NoteList> {
  const res = await request(url, {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new HttpError(`${method} ${url} failed: ${res.status}`, res.status);
  return res.json();
}

export function createNote(note: { title: string; text: string; geometry: GeoJSON.Point }): Promise<NoteList> {
  return changeNotes("POST", "/api/notes", note);
}

export function updateNote(id: string, change: NoteChange): Promise<NoteList> {
  return changeNotes("PATCH", `/api/notes/${id}`, change);
}

export function deleteNote(id: string): Promise<NoteList> {
  return changeNotes("DELETE", `/api/notes/${id}`);
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
