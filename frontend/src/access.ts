import { createContext, useContext } from "react";
import type { Me } from "./api/types";

/** Who this window is, and how it got in (see AccessGate). */
export interface AccessState {
  mechanism: "open" | "pin";
  me: Me;
  /** Forgets the token, back to the PIN screen (`pin` only). */
  changeTeam: () => void;
}

/** Without teams: the one team, an editor. */
export const OPEN_ACCESS: AccessState = {
  mechanism: "open",
  me: { team: { id: "default", name: "" }, member: null, role: "editor" },
  changeTeam: () => {},
};

export const AccessContext = createContext<AccessState>(OPEN_ACCESS);

export function useAccess(): AccessState {
  return useContext(AccessContext);
}
