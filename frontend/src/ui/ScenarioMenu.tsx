import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ScenarioInfo, SceneResponse } from "../api/types";
import {
  clearSession,
  deleteScenario,
  fetchScenarios,
  loadScenario,
  saveScenario,
  ScenarioExistsError,
} from "../api/client";
import { locale, tr } from "../i18n/lang";

interface Props {
  /** How many interventions the session has now: loading over them asks first. */
  interventionCount: number;
  /** The year shown, for the scene a load returns. */
  t: number;
  /** A scenario was loaded, or the cards cleared: the scene with them. */
  onSceneReplaced: (scene: SceneResponse) => void;
}

function formatSavedAt(savedAt: string | null): string {
  if (!savedAt) return "";
  return new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(savedAt));
}

function cardCount(n: number): string {
  return n === 1 ? tr("1 carta", "1 card") : tr(`${n} carte`, `${n} cards`);
}

/** Saved scenarios (see civic_twin/store/scenarios.py): save the session's
 * cards under a name, load a saved set in their place, or start afresh. The
 * session is shared, so a load or a clear changes it for every open window
 * (they follow within seconds); the cards replaced are kept on the server. */
export function ScenarioMenu({ interventionCount, t, onSceneReplaced }: Props) {
  const [open, setOpen] = useState(false);
  const [scenarios, setScenarios] = useState<ScenarioInfo[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  function refresh() {
    fetchScenarios()
      .then(setScenarios)
      .catch((err) => {
        console.error(err);
        setMessage({ text: tr("Impossibile leggere gli scenari salvati.", "Could not read the saved scenarios."), error: true });
      });
  }

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    refresh();
    // Closes on a click elsewhere, or Esc.
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function run(action: () => Promise<void>, failure: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      console.error(err);
      setMessage({ text: failure, error: true });
    } finally {
      setBusy(false);
    }
  }

  function replaceWarning(): string {
    return tr(
      `Le ${interventionCount} carte attuali saranno sostituite, in tutte le finestre aperte (ne resta una copia sul server).`,
      `The ${interventionCount} current cards will be replaced, in every open window (a copy is kept on the server).`
    );
  }

  function handleLoad(scenario: ScenarioInfo) {
    if (
      interventionCount > 0 &&
      !window.confirm(`${tr(`Caricare "${scenario.name}"?`, `Load "${scenario.name}"?`)}\n${replaceWarning()}`)
    ) {
      return;
    }
    run(async () => {
      onSceneReplaced(await loadScenario(scenario.id, t));
      setOpen(false);
    }, tr(`Impossibile caricare "${scenario.name}".`, `Could not load "${scenario.name}".`));
  }

  function handleDelete(scenario: ScenarioInfo) {
    if (!window.confirm(tr(`Eliminare lo scenario "${scenario.name}"?`, `Delete the scenario "${scenario.name}"?`))) return;
    run(async () => {
      await deleteScenario(scenario.id);
      refresh();
    }, tr(`Impossibile eliminare "${scenario.name}".`, `Could not delete "${scenario.name}".`));
  }

  function handleSave(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    run(async () => {
      let saved: ScenarioInfo;
      try {
        saved = await saveScenario(trimmed, false);
      } catch (err) {
        if (!(err instanceof ScenarioExistsError)) throw err;
        if (!window.confirm(tr(`Esiste già uno scenario "${trimmed}". Sostituirlo?`, `A scenario "${trimmed}" already exists. Replace it?`))) {
          return;
        }
        saved = await saveScenario(trimmed, true);
      }
      setName("");
      setMessage({
        text: tr(`Salvato "${saved.name}" (${cardCount(saved.interventions)}).`, `Saved "${saved.name}" (${cardCount(saved.interventions)}).`),
        error: false,
      });
      refresh();
    }, tr("Impossibile salvare lo scenario: serve un nome con almeno una lettera o una cifra.", "Could not save the scenario: it needs a name with at least a letter or a digit."));
  }

  function handleClear() {
    if (!window.confirm(`${tr("Ripartire senza carte?", "Start again with no cards?")}\n${replaceWarning()}`)) return;
    run(async () => {
      onSceneReplaced(await clearSession(t));
      setOpen(false);
    }, tr("Impossibile togliere le carte.", "Could not remove the cards."));
  }

  return (
    <div className="scenario-menu" ref={rootRef}>
      <button type="button" className="scenario-menu__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {tr("Scenari", "Scenarios")} {open ? "▴" : "▾"}
      </button>
      {open && (
        <div className="scenario-menu__panel">
          <h3>{tr("Scenari salvati", "Saved scenarios")}</h3>
          {scenarios === null ? (
            <p className="scenario-menu__note">{tr("Caricamento…", "Loading…")}</p>
          ) : scenarios.length === 0 ? (
            <p className="scenario-menu__note">{tr("Nessuno scenario salvato.", "No saved scenarios.")}</p>
          ) : (
            <ul className="scenario-menu__list">
              {scenarios.map((scenario) => (
                <li key={scenario.id}>
                  <span className="scenario-menu__name">
                    <strong>{scenario.name}</strong>
                    <span>
                      {[formatSavedAt(scenario.saved_at), cardCount(scenario.interventions)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <button type="button" disabled={busy} onClick={() => handleLoad(scenario)}>
                    {tr("Carica", "Load")}
                  </button>
                  <button
                    type="button"
                    className="scenario-menu__delete"
                    disabled={busy}
                    title={tr("Elimina lo scenario", "Delete the scenario")}
                    aria-label={tr("Elimina lo scenario", "Delete the scenario")}
                    onClick={() => handleDelete(scenario)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="scenario-menu__save" onSubmit={handleSave}>
            <label htmlFor="scenario-name">
              {tr(`Salva le carte attuali (${cardCount(interventionCount)}) come:`, `Save the current cards (${cardCount(interventionCount)}) as:`)}
            </label>
            <div>
              <input
                id="scenario-name"
                type="text"
                value={name}
                placeholder={tr("Nome dello scenario", "Scenario name")}
                onChange={(event) => setName(event.target.value)}
              />
              <button type="submit" disabled={busy || !name.trim()}>
                {tr("Salva", "Save")}
              </button>
            </div>
          </form>
          {message && (
            <p className={message.error ? "scenario-menu__note scenario-menu__note--error" : "scenario-menu__note"}>
              {message.text}
            </p>
          )}
          <button type="button" className="scenario-menu__clear" disabled={busy || interventionCount === 0} onClick={handleClear}>
            {tr("Ricomincia senza carte", "Start again with no cards")}
          </button>
        </div>
      )}
    </div>
  );
}
