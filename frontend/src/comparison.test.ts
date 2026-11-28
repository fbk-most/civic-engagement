import { describe, expect, it } from "vitest";
import type { ScenarioInfo } from "./api/types";
import { initialCompared, keptCompared, sourceKey, sourceLabel } from "./comparison";

const scenario = (id: string, saved_at: string | null, preset = false): ScenarioInfo => ({
  id,
  name: id.toUpperCase(),
  saved_at,
  interventions: 1,
  preset,
});
// As the backend lists them: most recently saved first, presets (undated) last.
const SCENARIOS = [scenario("idea", "2026-11-28T10:00:00+00:00"), scenario("old", "2026-11-01T10:00:00+00:00"), scenario("demo", null, true)];

describe("comparison", () => {
  it("names a side after its scenario", () => {
    expect(sourceLabel("idea", SCENARIOS, "Now")).toBe("IDEA");
    expect(sourceLabel(null, SCENARIOS, "Now")).toBe("Now");
    expect(sourceLabel("gone", SCENARIOS, "Now")).toBe("gone");
  });

  it("keys a side on what it shows", () => {
    expect(sourceKey(null, SCENARIOS, "k1")).not.toBe(sourceKey(null, SCENARIOS, "k2"));
    // A saved scenario doesn't follow the current scene's cards...
    expect(sourceKey("idea", SCENARIOS, "k1")).toBe(sourceKey("idea", SCENARIOS, "k2"));
    // ...but does its saving again.
    const again = [scenario("idea", "2026-11-28T11:00:00+00:00")];
    expect(sourceKey("idea", again, "k1")).not.toBe(sourceKey("idea", SCENARIOS, "k1"));
  });

  it("starts with the current scene against the scenario saved last", () => {
    expect(initialCompared(SCENARIOS)).toEqual({ a: null, b: "idea" });
    expect(initialCompared([scenario("demo", null, true)])).toEqual({ a: null, b: "demo" });
    expect(initialCompared([])).toEqual({ a: null, b: null });
  });

  it("drops a scenario gone", () => {
    const compared = { a: "old", b: "idea" };
    expect(keptCompared(compared, SCENARIOS)).toBe(compared);
    expect(keptCompared(compared, [SCENARIOS[1]])).toEqual({ a: "old", b: null });
  });
});
