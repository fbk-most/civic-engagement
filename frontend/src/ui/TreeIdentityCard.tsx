import type { DiscreteElement, TreeProperties } from "../api/types";
import { tr } from "../i18n/lang";
import { ageClassLabel, speciesLabel, yearLabel } from "../i18n/labels";

interface Props {
  element: DiscreteElement;
  onClose: () => void;
  onReplant: () => void;
}

// Read-only: baseline tree identity (species/age/size/cut year) is assigned
// once, offline, as part of the baseline scenario — see
// civic_twin/domains/urban/trees.py and ingestion/build_baseline.py. Nothing here
// is editable in a live session; the only action available is replanting a
// stump, which creates a normal plant_tree intervention.
export function TreeIdentityCard({ element, onClose, onReplant }: Props) {
  const props = element.properties as unknown as TreeProperties;
  const isStump = props.status === "stump";

  return (
    <div className="param-form tree-identity-card">
      <h3>{isStump ? tr("Albero abbattuto", "Felled tree") : tr("Albero esistente", "Existing tree")}</h3>
      <p>
        <strong>{tr("Specie:", "Species:")}</strong> {speciesLabel(props.species)}
      </p>
      <p>
        <strong>{tr("Età:", "Age:")}</strong> {ageClassLabel(props.age_class)}
      </p>
      {!isStump && (
        <p>
          <strong>{tr("Diametro chioma:", "Crown diameter:")}</strong> {props.canopy_diameter.toFixed(1)} m
        </p>
      )}
      <p>
        <strong>{isStump ? tr("Abbattuto nell'anno", "Felled in year") : tr("Abbattimento previsto", "Felling planned")}:</strong>{" "}
        {props.cut_year === null ? tr("nessuno previsto in questo orizzonte", "none within this horizon") : yearLabel(props.cut_year)}
      </p>
      <div className="param-form__actions">
        {isStump && (
          <button type="button" onClick={onReplant}>
            {tr("Ripianta qui", "Replant here")}
          </button>
        )}
        <button type="button" onClick={onClose}>
          {tr("Chiudi", "Close")}
        </button>
      </div>
    </div>
  );
}
