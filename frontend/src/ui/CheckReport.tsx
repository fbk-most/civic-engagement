import type { InterventionCheck } from "../api/types";
import { COVER_TYPE_LABELS_IT, countLabel } from "../i18n/labels";

interface Props {
  check: InterventionCheck | null;
  checking: boolean;
  /** Whether the user confirmed the warnings; needed to place the card. */
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
}

/** "3 alberi, 2 panchine", the most numerous first. */
function listCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => countLabel(type, count))
    .join(", ");
}

/** What the backend says about the area of a card that clears it, before the
 * card is placed (see POST /api/interventions/check): what is in the way
 * (the card is refused), what to confirm, and what would be removed. Says
 * nothing for a card that has nothing to check. */
export function CheckReport({ check, checking, confirmed, onConfirmedChange }: Props) {
  if (checking) return <p className="check-report check-report--info">Controllo dell'area…</p>;
  if (!check) return null;

  const blocking: Record<string, number> = {};
  for (const { type } of check.blocking) blocking[type] = (blocking[type] ?? 0) + 1;
  const cleared = check.clearing.elements_by_type;

  return (
    <>
      {check.blocking.length > 0 && (
        <p className="check-report check-report--error" role="alert">
          L'area si sovrappone a: {listCounts(blocking)}. Ridisegnala lasciando liberi questi elementi.
        </p>
      )}
      {check.blocking.length === 0 && check.warnings.length > 0 && (
        <div className="check-report check-report--warning" role="alert">
          {check.warnings.map((warning) => (
            <p key={warning.cover_type}>
              Attenzione: la copertura «{(COVER_TYPE_LABELS_IT[warning.cover_type] ?? warning.cover_type).toLowerCase()}»
              ({Math.round(warning.area_m2)} m²) verrà rimossa e sostituita con quella circostante.
            </p>
          ))}
          <label className="check-report__confirm">
            <input type="checkbox" checked={confirmed} onChange={(e) => onConfirmedChange(e.target.checked)} />
            Confermo la sostituzione
          </label>
        </div>
      )}
      {check.blocking.length === 0 && Object.keys(cleared).length > 0 && (
        <p className="check-report check-report--info">Verranno rimossi: {listCounts(cleared)}.</p>
      )}
    </>
  );
}
