import { tr } from "../i18n/lang";
import { activePack, type FrontendPack } from "../pack";

type NoteWords = NonNullable<FrontendPack["notes"]>;

/** Generic, for a pack that doesn't name its notes. */
const DEFAULT_WORDS: NoteWords = {
  one: ["Nota", "Note"],
  many: ["Note", "Notes"],
  add: ["Aggiungi una nota", "Add a note"],
  color: "#2c7a7b",
};

/** The notes' words and colour: the pack's (`FrontendPack.notes`), or generic. */
export function noteWords(): NoteWords {
  return activePack().notes ?? DEFAULT_WORDS;
}

/** "Scritta da Anna · modificata da Bea", as for the cards; empty without teams. */
export function noteAuthors(note: { created_by: string | null; updated_by: string | null }): string {
  const parts = [];
  if (note.created_by) parts.push(tr(`Scritta da ${note.created_by}`, `Written by ${note.created_by}`));
  if (note.updated_by && note.updated_by !== note.created_by) {
    parts.push(tr(`modificata da ${note.updated_by}`, `changed by ${note.updated_by}`));
  }
  return parts.join(" · ");
}
