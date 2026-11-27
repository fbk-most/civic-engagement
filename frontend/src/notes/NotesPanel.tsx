import type { CSSProperties } from "react";
import { tr } from "../i18n/lang";
import "./notes.css";
import type { Notes } from "./useNotes";
import { noteWords } from "./words";

/** The notes' panel at the top of the 2D map's left rail: whether the
 * bubbles are shown on this screen (in 2D and 3D), and, for an editor the
 * phase lets change them, the button that adds one. Small enough not to
 * fold, unlike the panels below it. */
export function NotesPanel({ notes }: { notes: Notes }) {
  const words = noteWords();
  return (
    <div className="notes-list" style={{ "--card-color": words.color } as CSSProperties}>
      <div className="notes-list__header">
        <h3>
          <span className="notes-list__marker" />
          {tr(...words.many)}
        </h3>
        <label className="notes-list__switch" title={tr("Mostra sulla mappa", "Show on the map")}>
          <input type="checkbox" checked={notes.visible} onChange={(e) => notes.setVisible(e.target.checked)} />
          {tr("Mostra", "Show")}
        </label>
      </div>
      {notes.canEdit && (
        <button
          type="button"
          className="notes-add"
          aria-pressed={notes.mode.kind === "placing"}
          onClick={notes.mode.kind === "placing" ? notes.cancel : notes.startAdding}
        >
          + {tr(...words.add)}
        </button>
      )}
    </div>
  );
}
