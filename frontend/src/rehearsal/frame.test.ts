import { describe, expect, it } from "vitest";
import { shownView, withView } from "./frame";

describe("withView", () => {
  it("changes only the fragment's view", () => {
    expect(withView("/", "proposals")).toBe("/#view=proposals");
    expect(withView("/#view=needs", "proposals")).toBe("/#view=proposals");
    expect(withView("/?lang=en#view=needs", "results")).toBe("/?lang=en#view=results");
    expect(withView("https://twin.example/app/?t=5#x=1&view=needs", "as-is")).toBe(
      "https://twin.example/app/?t=5#x=1&view=as-is"
    );
    expect(withView("/#", "as-is")).toBe("/#view=as-is");
  });
});

describe("shownView", () => {
  const CODESIGN = ["needs", "proposals", "simulation"];

  it("takes the fragment's view if the phase has it, else the default", () => {
    expect(shownView("/#view=proposals", CODESIGN, true)).toBe("proposals");
    expect(shownView("/#view=as-is", CODESIGN, true)).toBe("needs");
    expect(shownView("/", CODESIGN, true)).toBe("needs");
    expect(shownView("/", [], true)).toBeNull();
  });

  it("has no default without a phase", () => {
    expect(shownView("/#view=proposals", CODESIGN, false)).toBe("proposals");
    expect(shownView("/", CODESIGN, false)).toBeNull();
  });
});
