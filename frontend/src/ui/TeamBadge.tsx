import type { AccessState } from "../access";
import { tr } from "../i18n/lang";

/** With teams: whose scene this is, and the way to another team. */
export function TeamBadge({ access }: { access: AccessState }) {
  const { me } = access;
  const who = me.role === "viewer" ? tr("osservatore", "viewer") : me.member?.name;
  return (
    <div className="team-badge">
      <span>
        <strong>{me.team.name}</strong>
        {who && <> · {who}</>}
      </span>
      <button type="button" onClick={access.changeTeam}>
        {tr("Cambia team", "Change team")}
      </button>
    </div>
  );
}
