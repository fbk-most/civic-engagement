/** The core frontend, as a domain pack's app uses it. */
import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { registerPack, type FrontendPack } from "./pack";

export type { FrontendPack } from "./pack";

/** Renders the app for `pack` into `root`. */
export function startApp(pack: FrontendPack, root: HTMLElement): void {
  registerPack(pack);
  createRoot(root).render(createElement(StrictMode, null, createElement(App)));
}
