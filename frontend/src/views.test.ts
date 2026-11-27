import { describe, expect, it } from "vitest";
import type { ViewSpec } from "./api/types";
import { panelShown, requestedView, resolveView, tabAfter, viewInterventionMode, viewTabs } from "./views";

function view(id: string, panels: ViewSpec["panels"], more: Partial<ViewSpec> = {}): ViewSpec {
  return { id, label: id, label_en: id, panels, tab: "2d", intervention_mode: "simulated", ...more };
}

const AS_IS = view("as-is", ["tab.2d", "tab.3d", "tab.indicators", "kpi", "time", "legend"], { intervention_mode: "hidden" });
const PROPOSALS = view("proposals", ["tab.2d", "tab.3d", "cards", "interventions", "scenarios"], { intervention_mode: "cards" });
const SIMULATION = view("simulation", ["tab.2d", "tab.3d", "tab.indicators", "cards", "interventionMode", "time"]);
const RESULTS = view("results", ["tab.3d", "kpi"], { tab: "3d" });
const ALL = [AS_IS, PROPOSALS, SIMULATION, RESULTS];
const CODESIGN = ["proposals", "simulation"];

describe("requestedView", () => {
  it("reads the fragment, then the query", () => {
    expect(requestedView("", "")).toBeNull();
    expect(requestedView("?view=a", "")).toBe("a");
    expect(requestedView("", "#view=b")).toBe("b");
    expect(requestedView("?view=a", "#view=b")).toBe("b");
    expect(requestedView("?t=5&view=a&viewer=1", "#other=1")).toBe("a");
    expect(requestedView("?view=a", "#view=")).toBe("a");
    expect(requestedView("", "#x=1&view=b")).toBe("b");
  });
});

describe("resolveView", () => {
  it("takes the URL's view if the phase has it", () => {
    expect(resolveView("", "#view=simulation", CODESIGN, ALL)).toBe(SIMULATION);
    expect(resolveView("?view=simulation", "", CODESIGN, ALL)).toBe(SIMULATION);
    expect(resolveView("?view=proposals", "#view=simulation", CODESIGN, ALL)).toBe(SIMULATION);
  });

  it("falls back to the phase's default", () => {
    expect(resolveView("", "", CODESIGN, ALL)).toBe(PROPOSALS);
    expect(resolveView("", "#view=as-is", CODESIGN, ALL)).toBe(PROPOSALS); // not the phase's
    expect(resolveView("", "#view=nowhere", CODESIGN, ALL)).toBe(PROPOSALS);
    // The fragment wins even when it names one the phase hasn't.
    expect(resolveView("?view=simulation", "#view=as-is", CODESIGN, ALL)).toBe(PROPOSALS);
  });

  it("shows everything without views", () => {
    expect(resolveView("", "#view=as-is", [], ALL)).toBeNull(); // a phase without views
    expect(resolveView("", "#view=as-is", ["as-is"], [])).toBeNull(); // a pack without
    expect(resolveView("", "#view=as-is", null, [])).toBeNull();
  });

  it("lets any of the pack's views be asked for without a phase", () => {
    expect(resolveView("", "", null, ALL)).toBeNull();
    expect(resolveView("", "#view=results", null, ALL)).toBe(RESULTS);
    expect(resolveView("", "#view=nowhere", null, ALL)).toBeNull();
  });
});

describe("panels", () => {
  const editor = ["interventions.edit", "scenarios.edit"] as const;
  it("follow the view, the role and the phase", () => {
    expect(panelShown(PROPOSALS, "cards", editor)).toBe(true);
    expect(panelShown(PROPOSALS, "cards", [])).toBe(false); // a viewer, or a phase without cards
    expect(panelShown(PROPOSALS, "interventions", [])).toBe(true);
    expect(panelShown(PROPOSALS, "kpi", editor)).toBe(false);
    expect(panelShown(AS_IS, "scenarios", editor)).toBe(false);
    expect(panelShown(null, "kpi", [])).toBe(true);
    expect(panelShown(null, "scenarios", [])).toBe(false);
    expect(panelShown(null, "scenarios", editor)).toBe(true);
  });

  it("offer their tabs", () => {
    expect(viewTabs(null)).toEqual(["2d", "3d", "indicators"]);
    expect(viewTabs(PROPOSALS)).toEqual(["2d", "3d"]);
    expect(viewTabs(RESULTS)).toEqual(["3d"]);
  });

  it("fix the interventions' display without the switch", () => {
    expect(viewInterventionMode(null, "cards")).toBe("cards");
    expect(viewInterventionMode(SIMULATION, "cards")).toBe("cards");
    expect(viewInterventionMode(AS_IS, "simulated")).toBe("hidden");
    expect(viewInterventionMode(PROPOSALS, "simulated")).toBe("cards");
  });
});

describe("tabAfter", () => {
  it("opens a view on its tab when that changes, or the tab shown isn't offered", () => {
    expect(tabAfter(null, PROPOSALS, "3d")).toBe("2d"); // the first view
    expect(tabAfter(PROPOSALS, SIMULATION, "3d")).toBe("3d"); // same opening tab: kept
    expect(tabAfter(SIMULATION, PROPOSALS, "indicators")).toBe("2d"); // not offered
    expect(tabAfter(SIMULATION, RESULTS, "2d")).toBe("3d");
    expect(tabAfter(RESULTS, null, "3d")).toBe("3d"); // no view: kept
  });
});
