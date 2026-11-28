import { describe, expect, it } from "vitest";
import { fileSlug, imageFileName } from "./imageExport";

describe("image file names", () => {
  it("are safe and readable", () => {
    expect(fileSlug("Tavolo 1")).toBe("tavolo-1");
    expect(fileSlug("Più verde, meno caldo!")).toBe("piu-verde-meno-caldo");
    expect(fileSlug("!!!")).toBe("x");
  });

  it("name the site, team, scenario, year and view", () => {
    expect(imageFileName({ site: "giardini_margherita", team: "tavolo-1", scenario: "Più ombra", year: 2036, view: "3d" })).toBe(
      "giardini-margherita_tavolo-1_piu-ombra_2036_3d.png"
    );
    expect(imageFileName({ site: "piazza", team: "default", scenario: null, year: 2026, view: "2d" })).toBe(
      "piazza_default_corrente_2026_2d.png"
    );
    // A comparison: both scenarios (App's pairImageName).
    expect(imageFileName({ site: "piazza", team: "tavolo-1", scenario: "corrente vs Più ombra", year: 2031, view: "2d" })).toBe(
      "piazza_tavolo-1_corrente-vs-piu-ombra_2031_2d.png"
    );
  });
});
