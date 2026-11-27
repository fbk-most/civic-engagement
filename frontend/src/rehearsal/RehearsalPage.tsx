import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAuthInfo,
  fetchMe,
  fetchRehearsal,
  HttpError,
  onTokenChange,
  setRehearsalPhase,
  storedToken,
} from "../api/client";
import type { Me, Rehearsal } from "../api/types";
import { followOtherWindows, tr, useLang } from "../i18n/lang";
import { shownView, withView } from "./frame";
import "./RehearsalPage.css";

type State =
  | { kind: "loading" }
  | { kind: "off"; why: "open" | "off" }
  | { kind: "out" }
  | { kind: "in"; me: Me; rehearsal: Rehearsal };

// How often the page asks who the frame is logged in as, and in which
// phase (as the app's own revision poll).
const POLL_MS = 3000;

/** Stands in for the container site, for user tests: a strip with the
 * team's phase (an editor moves it: CIVIC_ENGAGEMENT_REHEARSAL=1) and the
 * phase's views, the app below in a frame. The page shares the frame's
 * token (same origin, same storage); a view is chosen as a container site
 * would, by changing only the fragment of the frame's `src`. */
export function RehearsalPage() {
  const lang = useLang();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [src, setSrc] = useState("/");
  const [error, setError] = useState<string | null>(null);
  // The pack's phases and views, asked for again for another member.
  const rehearsalRef = useRef<{ member: string | null; rehearsal: Rehearsal } | null>(null);
  // Only the latest check's answer counts.
  const checkRef = useRef(0);

  const check = useCallback(async () => {
    const n = ++checkRef.current;
    const settle = (next: State) => {
      if (n === checkRef.current) setState(next);
    };
    if (!storedToken()) {
      settle({ kind: "out" });
      return;
    }
    try {
      const me = await fetchMe();
      const member = me.member?.id ?? null;
      if (rehearsalRef.current?.member !== member) {
        rehearsalRef.current = { member, rehearsal: await fetchRehearsal() };
      }
      settle({ kind: "in", me, rehearsal: rehearsalRef.current.rehearsal });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) settle({ kind: "out" });
      else if (err instanceof HttpError && err.status === 404) settle({ kind: "off", why: "off" });
      else console.error(err);
    }
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    let stop = () => {};
    fetchAuthInfo()
      .then((info) => {
        if (info.mechanism === "open") {
          setState({ kind: "off", why: "open" });
          return;
        }
        void check();
        timer = window.setInterval(() => void check(), POLL_MS);
        stop = onTokenChange(() => void check());
      })
      .catch((err) => console.error(err));
    const unfollow = followOtherWindows();
    return () => {
      window.clearInterval(timer);
      stop();
      unfollow();
    };
  }, [check]);

  const label = (spec: { label: string; label_en: string }) => (lang === "en" ? spec.label_en : spec.label);

  const changePhase = (phase: string) => {
    setError(null);
    setRehearsalPhase(phase)
      .then((me) => setState((state) => (state.kind === "in" ? { ...state, me } : state)))
      .catch((err) => {
        const status = err instanceof HttpError ? err.status : 0;
        setError(
          status === 403
            ? tr("Solo un editor può cambiare la fase.", "Only an editor can change the phase.")
            : status === 404
              ? tr("La prova non è attiva sul server.", "Rehearsal is not enabled on the server.")
              : tr("Fase non cambiata", "Phase not changed") + (status ? ` (${status})` : "")
        );
      });
  };

  let strip;
  if (state.kind === "loading") {
    strip = null;
  } else if (state.kind === "off") {
    strip =
      state.why === "open"
        ? tr("La prova richiede i team (CIVIC_ENGAGEMENT_AUTH=pin).", "Rehearsal needs teams (CIVIC_ENGAGEMENT_AUTH=pin).")
        : tr(
            "La prova non è attiva sul server (CIVIC_ENGAGEMENT_REHEARSAL=1).",
            "Rehearsal is not enabled on the server (CIVIC_ENGAGEMENT_REHEARSAL=1)."
          );
  } else if (state.kind === "out") {
    strip = tr("Inserisci il PIN qui sotto.", "Enter the PIN below.");
  } else {
    const { me, rehearsal } = state;
    const phased = me.phase !== null;
    const views = phased ? me.views : rehearsal.views.map((view) => view.id);
    const current = shownView(src, views, phased);
    const who = me.role === "editor" ? "editor" : tr("osservatore", "viewer");
    const phase = rehearsal.phases.find((phase) => phase.id === me.phase);
    const phaseLabel = phase ? label(phase) : me.phase;
    strip = (
      <>
        <span className="rehearsal__who">
          <strong>{me.team.name}</strong> · {me.member?.name ? `${me.member.name}, ${who}` : who}
        </span>
        {rehearsal.can_set_phase && rehearsal.phases.length > 0 && (
          <span className="rehearsal__group" role="group" aria-label={tr("Fase", "Phase")}>
            <span className="rehearsal__caption">{tr("Fase", "Phase")}</span>
            {rehearsal.phases.map((phase) => (
              <button
                key={phase.id}
                type="button"
                aria-pressed={phase.id === me.phase}
                onClick={() => changePhase(phase.id)}
              >
                {label(phase)}
              </button>
            ))}
          </span>
        )}
        {!rehearsal.can_set_phase && phased && (
          <span>
            {tr("Fase", "Phase")}:{" "}
            <strong>{phaseLabel}</strong>
          </span>
        )}
        {views.length > 0 && (
          <span className="rehearsal__group" role="group" aria-label={tr("Vista", "View")}>
            <span className="rehearsal__caption">{tr("Vista", "View")}</span>
            {views.map((id) => {
              const view = rehearsal.views.find((view) => view.id === id);
              return (
                <button key={id} type="button" aria-pressed={id === current} onClick={() => setSrc(withView(src, id))}>
                  {view ? label(view) : id}
                </button>
              );
            })}
          </span>
        )}
        {error && <span className="rehearsal__error">{error}</span>}
      </>
    );
  }

  return (
    <div className="rehearsal">
      <div className="rehearsal__strip">
        <span className="rehearsal__title">{tr("Prova", "Rehearsal")}</span>
        {strip}
      </div>
      <iframe className="rehearsal__frame" src={src} title={tr("L'app", "The app")} />
    </div>
  );
}
