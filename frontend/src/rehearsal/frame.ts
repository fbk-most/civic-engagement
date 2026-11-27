import { requestedView } from "../views";

/** The rehearsal page's frame (RehearsalPage): pure functions, so that
 * they can be tested (frame.test.ts). */

/** `src` with `view=<id>` in its fragment, the rest of it as it was: what
 * a container site sets as the frame's `src` to change the view without
 * reloading the app (only the fragment changes). */
export function withView(src: string, view: string): string {
  const at = src.indexOf("#");
  const base = at < 0 ? src : src.slice(0, at);
  const params = new URLSearchParams(at < 0 ? "" : src.slice(at + 1));
  params.set("view", view);
  return `${base}#${params.toString()}`;
}

/** The view the app in the frame shows (as views.ts's `resolveView`): the
 * one in `src`'s fragment if the phase has it, else the phase's default
 * (its first). `phased`, false without a phase: any may be asked for, and
 * there's no default. */
export function shownView(src: string, views: string[], phased: boolean): string | null {
  const at = src.indexOf("#");
  const asked = requestedView("", at < 0 ? "" : src.slice(at));
  if (asked !== null && views.includes(asked)) return asked;
  return phased ? (views[0] ?? null) : null;
}
