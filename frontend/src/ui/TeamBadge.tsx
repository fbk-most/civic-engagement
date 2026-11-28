import { useState } from "react";
import type { AccessState } from "../access";
import { tr } from "../i18n/lang";

/** With teams: whose scene this is, and the way out (back to the PIN
 * screen, for another team or member). Asked twice, in the badge itself:
 * a browser dialog (`confirm`) may be blocked in the container site's
 * frame (a sandbox without `allow-modals`). */
export function TeamBadge({ access }: { access: AccessState }) {
  const { me } = access;
  const [confirming, setConfirming] = useState(false);
  const who = me.role === "viewer" ? tr("osservatore", "viewer") : me.member?.name;
  return (
    <div className="team-badge">
      <span>
        <strong>{me.team.name}</strong>
        {who && <> · {who}</>}
      </span>
      {confirming ? (
        <span className="team-badge__confirm" role="group" aria-label={tr("Conferma l'uscita", "Confirm exit")}>
          {tr("Uscire?", "Exit?")}
          <button type="button" onClick={access.changeTeam}>
            {tr("Esci", "Exit")}
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            {tr("Annulla", "Cancel")}
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          title={tr("Torna alla schermata del codice", "Back to the code screen")}
        >
          {tr("Esci", "Exit")}
        </button>
      )}
    </div>
  );
}
