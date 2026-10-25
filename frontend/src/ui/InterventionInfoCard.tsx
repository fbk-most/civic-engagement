import type { CSSProperties } from "react";
import type { CardSpec, Intervention } from "../api/types";
import { tr } from "../i18n/lang";
import { authorsLabel, cardLabel, summarizeParams, yearLabel } from "../i18n/labels";
import { CardIcon } from "./cardIcons";
import { categoryColor } from "./categoryColors";

interface Props {
  intervention: Intervention;
  card: CardSpec | null;
  /** Absent for a viewer, who can't change it. */
  onEdit?: () => void;
  onClose: () => void;
}

/** Read-only details of a card: picked in the 3D view, where editing stays
 * on the 2D map, so this only offers the way there; or a viewer's, who
 * only looks. */
export function InterventionInfoCard({ intervention, card, onEdit, onClose }: Props) {
  const color = card ? categoryColor(card.category) : "#999";
  return (
    <div className="param-form intervention-info" style={{ "--card-color": color } as CSSProperties}>
      <div className="intervention-info__title">
        <span className="intervention-info__icon">{card && <CardIcon cardType={card.card_type} />}</span>
        <h3>{card ? cardLabel(card) : intervention.card_type}</h3>
      </div>
      <p className="param-form__planted-year">
        {tr("In vigore da: ", "In effect from: ")}<strong>{yearLabel(intervention.planted_year)}</strong>
      </p>
      <p className="intervention-info__summary">{summarizeParams(card ?? undefined, intervention.params)}</p>
      {authorsLabel(intervention) && <p className="param-form__authors">{authorsLabel(intervention)}</p>}
      <div className="param-form__actions">
        {onEdit && (
          <button type="submit" onClick={onEdit}>
            {tr("Modifica nella mappa 2D", "Edit on the 2D map")}
          </button>
        )}
        <button type="button" onClick={onClose}>
          {tr("Chiudi", "Close")}
        </button>
      </div>
    </div>
  );
}
