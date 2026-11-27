import { describe, expect, it } from "vitest";
import type { Note } from "../api/types";
import { DRAFT, NO_TITLE, noteBubbles } from "./bubbles";

const at = (lng: number): GeoJSON.Point => ({ type: "Point", coordinates: [lng, 44.5] });
const note = (id: string, title: string): Note => ({
  id, title, text: "", geometry: at(11), created_at: "", created_by: null, updated_by: null,
});
const NOTES = [note("a", "Shade"), note("b", "Benches"), note("c", "Water")];

describe("noteBubbles", () => {
  it("draws the open note last, outlined", () => {
    const bubbles = noteBubbles(NOTES, "a", false, null);
    expect(bubbles.map((b) => b.id)).toEqual(["b", "c", "a"]);
    expect(bubbles.map((b) => b.selected)).toEqual([false, false, true]);
    expect(bubbles.some((b) => b.moving)).toBe(false);
  });

  it("fades only the note being moved", () => {
    expect(noteBubbles(NOTES, "b", true, null).filter((b) => b.moving).map((b) => b.id)).toEqual(["b"]);
    expect(noteBubbles(NOTES, null, true, null).some((b) => b.moving)).toBe(false);
  });

  it("adds the note being written, with its title so far", () => {
    const empty = noteBubbles(NOTES, null, false, { point: at(12), title: "  " }).at(-1)!;
    expect([empty.id, empty.title, empty.selected, empty.point]).toEqual([DRAFT, NO_TITLE, true, at(12)]);
    expect(noteBubbles([], null, false, { point: at(12), title: " Shade " })[0].title).toBe("Shade");
  });
});
