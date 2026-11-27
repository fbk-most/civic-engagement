import { tr } from "../i18n/lang";

interface Props {
  /** Absent for whoever can't turn it on (a viewer, a phase that doesn't allow it). */
  onEnable?: () => void;
}

/** A card turned off, said where its details are shown (the info box, the
 * edit form): greyed on the map, it would otherwise read as any other. */
export function CardOffNotice({ onEnable }: Props) {
  return (
    <div className="card-off-notice">
      <span>{tr("Non selezionato: fuori dalla simulazione", "Not selected: left out of the simulation")}</span>
      {onEnable && (
        <button type="button" onClick={onEnable}>
          {tr("Seleziona", "Select")}
        </button>
      )}
    </div>
  );
}
