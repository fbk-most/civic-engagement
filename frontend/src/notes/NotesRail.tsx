import { useState, type CSSProperties } from "react";
import { tr } from "../i18n/lang";
import "./notes.css";
import type { Notes } from "./useNotes";
import { noteAuthors, noteWords } from "./words";

// As the backend's (civic_engagement/models/schema.py).
const TITLE_MAX = 80;
const TEXT_MAX = 2000;

/** The notes' part of the right rail: the hint while a point is being
 * chosen, the form, or the note open (adding one: notes/NotesPanel.tsx). */
export function NotesRail({ notes }: { notes: Notes }) {
  const words = noteWords();
  const style = { "--card-color": words.color } as CSSProperties;
  const { mode, selected } = notes;

  if (mode.kind === "placing" || mode.kind === "moving") {
    return (
      <div className="param-form notes-panel" style={style}>
        <h3>{mode.kind === "placing" ? tr(...words.add) : selected?.title}</h3>
        <p className="notes-panel__hint">
          {mode.kind === "placing"
            ? tr("Clicca sulla mappa per scegliere il punto.", "Click on the map to choose the place.")
            : tr("Clicca sulla mappa il nuovo punto.", "Click on the map at the new place.")}
        </p>
        <div className="param-form__actions">
          <button type="button" onClick={notes.cancel}>
            {tr("Annulla", "Cancel")}
          </button>
        </div>
      </div>
    );
  }
  if (mode.kind === "new" || (mode.kind === "editing" && selected)) {
    return (
      <NoteForm
        key={mode.kind === "new" ? JSON.stringify(mode.point) : selected!.id}
        heading={mode.kind === "new" ? tr(...words.add) : tr(...words.one)}
        initial={mode.kind === "editing" ? selected! : undefined}
        style={style}
        onSave={notes.save}
        onTitleChange={mode.kind === "new" ? notes.setDraftTitle : undefined}
        onCancel={notes.cancel}
      />
    );
  }
  if (selected) {
    return (
      <div className="param-form notes-panel" style={style}>
        <span className="notes-panel__kind">{tr(...words.one)}</span>
        <h3>{selected.title}</h3>
        {selected.text && <p className="notes-panel__text">{selected.text}</p>}
        {noteAuthors(selected) && <p className="param-form__authors">{noteAuthors(selected)}</p>}
        <div className="param-form__actions">
          {notes.canEdit && (
            <>
              <button type="submit" onClick={notes.startEditing}>
                {tr("Modifica", "Edit")}
              </button>
              <button type="button" onClick={notes.startMoving}>
                {tr("Sposta", "Move")}
              </button>
            </>
          )}
          <button type="button" onClick={() => notes.select(null)}>
            {tr("Chiudi", "Close")}
          </button>
          {notes.canEdit && (
            <button type="button" className="param-form__delete" onClick={notes.remove}>
              {tr("Elimina", "Delete")}
            </button>
          )}
        </div>
      </div>
    );
  }
  return null;
}

function NoteForm({
  heading,
  initial,
  style,
  onSave,
  onTitleChange,
  onCancel,
}: {
  heading: string;
  initial?: { title: string; text: string };
  style: CSSProperties;
  onSave: (title: string, text: string) => void;
  /** Each change of the title, as typed. */
  onTitleChange?: (title: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  return (
    <form
      className="param-form notes-panel"
      style={style}
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onSave(title.trim(), text.trim());
      }}
    >
      <h3>{heading}</h3>
      <label className="param-form__field">
        {tr("Titolo", "Title")}
        <input
          type="text"
          value={title}
          maxLength={TITLE_MAX}
          required
          autoFocus
          onChange={(e) => {
            setTitle(e.target.value);
            onTitleChange?.(e.target.value);
          }}
        />
      </label>
      <label className="param-form__field">
        {tr("Descrizione (facoltativa)", "Description (optional)")}
        <textarea value={text} maxLength={TEXT_MAX} rows={4} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="param-form__actions">
        <button type="submit" disabled={!title.trim()}>
          {tr("Salva", "Save")}
        </button>
        <button type="button" onClick={onCancel}>
          {tr("Annulla", "Cancel")}
        </button>
      </div>
    </form>
  );
}
