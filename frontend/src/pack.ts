/** The frontend side of a domain pack (see civic_engagement/domain.py for
 * the backend's): what the core's interface needs from the domain. Each
 * pack's app passes its own to `startApp`, which registers it before
 * anything renders; modules outside React read it with `activePack()`. */
export interface FrontendPack {
  id: string;
  /** The app's name, e.g. in the window title. */
  title: string;
}

let pack: FrontendPack | null = null;

export function registerPack(next: FrontendPack): void {
  if (pack !== null && pack !== next) throw new Error(`A frontend pack (${pack.id}) is already registered`);
  pack = next;
}

export function activePack(): FrontendPack {
  if (pack === null) throw new Error("No frontend pack registered: start the app with startApp(pack)");
  return pack;
}
