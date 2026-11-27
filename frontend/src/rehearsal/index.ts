/** The rehearsal page (RehearsalPage), as a domain pack's rehearsal.html
 * uses it: apart from the app's entry, so that the page loads only itself. */
import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { RehearsalPage } from "./RehearsalPage";

/** Renders the rehearsal page into `root`. */
export function startRehearsal(root: HTMLElement): void {
  createRoot(root).render(createElement(StrictMode, null, createElement(RehearsalPage)));
}
