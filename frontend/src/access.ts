import { createContext, useContext } from "react";
import type { Me, Operation } from "./api/types";

/** Who this window is, and how it got in (see AccessGate). */
export interface AccessState {
  mechanism: "open" | "pin";
  me: Me;
  /** Forgets the token, back to the PIN screen (`pin` only). */
  changeTeam: () => void;
  /** Asks again who this is: after a change of phase. */
  refresh: () => void;
}

/** Whether this window may change something now: its role (an editor) and
 * its team's phase allow it (civic_engagement/phases.py). The backend
 * refuses the rest anyway. */
export function can(access: AccessState, operation: Operation): boolean {
  return access.me.operations.includes(operation);
}

/** Without teams and without phases: the one team, an editor, nothing blocked. */
export const OPEN_ACCESS: AccessState = {
  mechanism: "open",
  me: {
    team: { id: "default", name: "" },
    member: null,
    role: "editor",
    phase: null,
    operations: ["notes.edit", "interventions.edit", "scenarios.edit"],
    views: [],
  },
  changeTeam: () => {},
  refresh: () => {},
};

export const AccessContext = createContext<AccessState>(OPEN_ACCESS);

export function useAccess(): AccessState {
  return useContext(AccessContext);
}
