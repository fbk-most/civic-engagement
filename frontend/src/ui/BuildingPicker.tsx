import type { CardSpec } from "../api/types";
import { tr } from "../i18n/lang";
import { cardLabel } from "../i18n/labels";

interface Props {
  card: CardSpec;
  /** How many buildings are picked so far. */
  picked: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/** While a card on buildings is armed: a click on a building of the map
 * picks it (or unpicks it), and the card is placed on those picked. */
export function BuildingPicker({ card, picked, onConfirm, onCancel }: Props) {
  return (
    <div className="param-form">
      <h3>{cardLabel(card)}</h3>
      <p className="param-form__planted-year">
        {tr(
          "Clicca sugli edifici della mappa per sceglierli (di nuovo per toglierli).",
          "Click the buildings on the map to pick them (again to unpick them)."
        )}
      </p>
      <p>{picked === 1 ? tr("1 edificio scelto", "1 building picked") : tr(`${picked} edifici scelti`, `${picked} buildings picked`)}</p>
      <div className="param-form__actions">
        <button type="submit" disabled={picked === 0} onClick={onConfirm}>
          {tr("Avanti", "Next")}
        </button>
        <button type="button" onClick={onCancel}>
          {tr("Annulla", "Cancel")}
        </button>
      </div>
    </div>
  );
}
