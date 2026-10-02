/** The character models available to the crowd, prepared by
 * `scripts/prepare-people.mjs` into `public/assets/3d/people/`. Kept free of
 * three.js imports so the (pure) crowd planner can depend on it. */

export interface CharacterSpec {
  file: string;
  /** Picks the plausible standing-height range. */
  build: "female" | "male";
}

export const CHARACTERS: CharacterSpec[] = [
  { file: "w-casual", build: "female" },
  { file: "w-formal", build: "female" },
  { file: "w-suit", build: "female" },
  { file: "w-adventurer", build: "female" },
  { file: "m-casual2", build: "male" },
  { file: "m-hoodie", build: "male" },
  { file: "m-suit", build: "male" },
  { file: "m-beach", build: "male" },
];

/** Standing height in metres, by build, for a 0-1 draw. */
export function standingHeight(build: CharacterSpec["build"], u: number): number {
  return build === "female" ? 1.58 + u * 0.14 : 1.7 + u * 0.16;
}
