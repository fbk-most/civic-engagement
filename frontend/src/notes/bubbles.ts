import type { Note } from "../api/types";

/** A bubble on the map: a note, or the one being added (`id` DRAFT). */
export interface Bubble {
  id: string;
  title: string;
  point: GeoJSON.Point;
  /** Outlined: the note open, or the one being added. */
  selected: boolean;
  /** Faded: the note being moved. */
  moving: boolean;
}

export const DRAFT = "draft";
/** The title of a note being added before a word is typed. */
export const NO_TITLE = "…";

/** The bubbles to draw: the notes, the open one last (over the others),
 * then the one being added, if any, with its title as typed so far. */
export function noteBubbles(
  notes: Note[],
  selected: string | null,
  moving: boolean,
  draft: { point: GeoJSON.Point; title: string } | null
): Bubble[] {
  const bubble = (note: Note): Bubble => {
    const isSelected = note.id === selected;
    return { id: note.id, title: note.title, point: note.geometry, selected: isSelected, moving: isSelected && moving };
  };
  const bubbles = [...notes.filter((n) => n.id !== selected), ...notes.filter((n) => n.id === selected)].map(bubble);
  if (draft) bubbles.push({ id: DRAFT, title: draft.title.trim() || NO_TITLE, point: draft.point, selected: true, moving: false });
  return bubbles;
}
