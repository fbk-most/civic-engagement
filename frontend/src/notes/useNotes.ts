import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { createNote, deleteNote, fetchNotes, HttpError, updateNote } from "../api/client";
import type { Note, NoteChange, NoteList, SceneResponse } from "../api/types";
import { tr } from "../i18n/lang";
import { withinBoundary } from "../map/boundary";
import { noteBubbles } from "./bubbles";
import { NOTES_LAYER, setNotesArmed, setNotesLayer } from "./notesLayer";

/** What the notes' controls are doing: nothing (a note may be open), a
 * new one waiting for its point then its words (drawn meanwhile, with its
 * title as typed), one being changed, one waiting for its new point. */
export type NoteMode =
  | { kind: "idle" }
  | { kind: "placing" }
  | { kind: "new"; point: GeoJSON.Point; title: string }
  | { kind: "editing" }
  | { kind: "moving" };

interface Options {
  mapRef: RefObject<MapLibreMap | null>;
  sceneRef: RefObject<SceneResponse | null>;
  /** The map and the scene's layers are there. */
  ready: boolean;
  /** The view shows the notes. */
  shown: boolean;
  /** This member may change them now (role and phase). */
  canEdit: boolean;
  /** The 2D map is the tab shown: only there are notes added or moved. */
  on2d: boolean;
  /** A card is being placed: the map's clicks are its. */
  blocked: boolean;
  showNotice: (message: string) => void;
  /** A note opened, or one being added: whatever else was open closes. */
  onActivate: () => void;
}

export interface Notes {
  /** The notes to draw: none when hidden (the view, or the legend's switch). */
  drawn: Note[];
  /** The notes panel's switch, this screen's own (2D and 3D). */
  visible: boolean;
  setVisible: (visible: boolean) => void;
  /** The note open in the right rail. */
  selected: Note | null;
  mode: NoteMode;
  /** The map's next click is a note's point: the cursor says so. */
  placing: boolean;
  canEdit: boolean;
  on2d: boolean;
  select: (id: string | null) => void;
  startAdding: () => void;
  /** The new note's title as it's typed: its bubble follows. */
  setDraftTitle: (title: string) => void;
  startEditing: () => void;
  startMoving: () => void;
  /** Back to looking (the open note stays open). */
  cancel: () => void;
  /** The new note's, or the open one's, title and text. */
  save: (title: string, text: string) => void;
  remove: () => void;
  /** The notes' revision from the poll (GET /session/revision): fetched
   * again if it isn't theirs. */
  follow: (revision: string) => void;
}

const IDLE: NoteMode = { kind: "idle" };
const NONE: Note[] = [];

function outsideMessage(): string {
  return tr("Va posizionato dentro il confine del sito.", "It goes within the site’s boundary.");
}

/** The team's notes on this screen: fetched while the view shows them,
 * fetched again when the poll says they changed, drawn on the 2D map, and
 * changed from the left rail's panel (notes/NotesPanel.tsx) and the right
 * rail (notes/NotesRail.tsx). */
export function useNotes({ mapRef, sceneRef, ready, shown, canEdit, on2d, blocked, showNotice, onActivate }: Options): Notes {
  const [list, setList] = useState<NoteList | null>(null);
  const [visible, setVisible] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<NoteMode>(IDLE);
  const active = shown && visible;
  const drawn = useMemo(() => (active && list ? list.notes : NONE), [active, list]);
  const selected = drawn.find((n) => n.id === selectedId) ?? null;

  // The latest of everything the map's handlers, registered once, read.
  const state = useRef({ mode, selected, active, blocked, onActivate, showNotice });
  state.current = { mode, selected, active, blocked, onActivate, showNotice };

  // Fetched when the view starts showing them; the answers numbered, so
  // that one overtaken by a change made here doesn't bring back the old.
  const requestRef = useRef(0);
  const revisionRef = useRef<string | null>(null);
  const apply = useCallback((next: NoteList) => {
    revisionRef.current = next.revision;
    setList(next);
  }, []);
  const refresh = useCallback(() => {
    const request = ++requestRef.current;
    fetchNotes()
      .then((next) => {
        if (request === requestRef.current) apply(next);
      })
      .catch((err) => console.error(err));
  }, [apply]);
  useEffect(() => {
    if (shown) refresh();
  }, [shown, refresh]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const follow = useCallback(
    (revision: string) => {
      if (shownRef.current && revision !== revisionRef.current) refresh();
    },
    [refresh]
  );

  // A change: its answer is the team's notes.
  const change = useCallback(
    (call: Promise<NoteList>, after: () => void) => {
      const request = ++requestRef.current;
      call
        .then((next) => {
          if (request === requestRef.current) apply(next);
          after();
        })
        .catch((err) => {
          console.error(err);
          if (err instanceof HttpError && err.status === 422) showNotice(outsideMessage());
          // Gone meanwhile (another screen): what's there now.
          if (err instanceof HttpError && err.status === 404) {
            setMode(IDLE);
            refresh();
          }
        });
    },
    [apply, refresh, showNotice]
  );

  // Nothing to change when the phase, the view or the tab no longer
  // allows it; nothing open when they're hidden.
  const editable = canEdit && active && on2d;
  useEffect(() => {
    if (!editable) setMode(IDLE);
  }, [editable]);
  useEffect(() => {
    if (!active) setSelectedId(null);
  }, [active]);

  // Placing and moving take the map's next click; while a new note's
  // words are written, the map's clicks are nobody's (one would close it).
  const armed = mode.kind === "placing" || mode.kind === "moving";
  const claiming = armed || mode.kind === "new";
  useEffect(() => {
    setNotesArmed(claiming);
    return () => setNotesArmed(false);
  }, [claiming]);

  // The map's clicks: on a bubble, its note; anywhere, the point being chosen.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onBubble = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      const current = state.current;
      if (current.mode.kind !== "idle" || !current.active || current.blocked) return;
      const id = e.features?.[0]?.properties?.noteId as string | undefined;
      if (!id) return;
      current.onActivate();
      setSelectedId(id);
    };
    const onPoint = (e: MapMouseEvent) => {
      const { mode: current, selected: note, showNotice: notice } = state.current;
      if (current.kind !== "placing" && current.kind !== "moving") return;
      const point: GeoJSON.Point = { type: "Point", coordinates: [e.lngLat.lng, e.lngLat.lat] };
      const scene = sceneRef.current;
      if (scene?.boundary_status === "surveyed" && !withinBoundary(point, scene.site_boundary)) {
        notice(outsideMessage());
        return;
      }
      if (current.kind === "placing") setMode({ kind: "new", point, title: "" });
      else if (note) change(updateNote(note.id, { geometry: point }), () => setMode(IDLE));
    };
    const pointer = () => {
      if (state.current.mode.kind === "idle") map.getCanvas().style.cursor = "pointer";
    };
    const leave = () => {
      if (state.current.mode.kind === "idle") map.getCanvas().style.cursor = "";
    };
    map.on("click", NOTES_LAYER, onBubble);
    map.on("click", onPoint);
    map.on("mouseenter", NOTES_LAYER, pointer);
    map.on("mouseleave", NOTES_LAYER, leave);
    return () => {
      map.off("click", NOTES_LAYER, onBubble);
      map.off("click", onPoint);
      map.off("mouseenter", NOTES_LAYER, pointer);
      map.off("mouseleave", NOTES_LAYER, leave);
    };
  }, [mapRef, sceneRef, ready, change]);

  // Drawn on the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const draft = mode.kind === "new" ? mode : null;
    setNotesLayer(map, noteBubbles(drawn, selected?.id ?? null, mode.kind === "moving", draft));
  }, [mapRef, ready, drawn, selected, mode]);

  return {
    drawn,
    visible,
    setVisible,
    selected,
    mode,
    placing: armed,
    canEdit: editable,
    on2d,
    select: (id) => {
      setMode(IDLE);
      if (id) onActivate();
      setSelectedId(id);
    },
    startAdding: () => {
      onActivate();
      setSelectedId(null);
      setMode({ kind: "placing" });
    },
    setDraftTitle: (title) => setMode((m) => (m.kind === "new" ? { ...m, title } : m)),
    startEditing: () => setMode({ kind: "editing" }),
    startMoving: () => setMode({ kind: "moving" }),
    cancel: () => setMode(IDLE),
    save: (title, text) => {
      if (mode.kind === "new") {
        change(createNote({ title, text, geometry: mode.point }), () => setMode(IDLE));
      } else if (mode.kind === "editing" && selected) {
        const edit: NoteChange = { title, text };
        change(updateNote(selected.id, edit), () => setMode(IDLE));
      }
    },
    remove: () => {
      if (!selected) return;
      change(deleteNote(selected.id), () => {
        setMode(IDLE);
        setSelectedId(null);
      });
    },
    follow,
  };
}
