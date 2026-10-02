import type { DiscreteElement, TreeProperties } from "../api/types";
import { AGE_CLASS_LABELS_IT, SPECIES_LABELS_IT } from "../i18n/labels";

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
      <h3>{isStump ? "Albero abbattuto" : "Albero esistente"}</h3>
      <p>
        <strong>Specie:</strong> {SPECIES_LABELS_IT[props.species] ?? props.species}
      </p>
      <p>
        <strong>Età:</strong> {AGE_CLASS_LABELS_IT[props.age_class] ?? props.age_class}
      </p>
      {!isStump && (
        <p>
          <strong>Diametro chioma:</strong> {props.canopy_diameter.toFixed(1)} m
        </p>
      )}
      <p>
        <strong>{isStump ? "Abbattuto nell'anno" : "Abbattimento previsto"}:</strong>{" "}
        {props.cut_year === null ? "nessuno previsto in questo orizzonte" : `+${props.cut_year}a`}
      </p>
      <div className="param-form__actions">
        {isStump && (
          <button type="button" onClick={onReplant}>
            Ripianta qui
          </button>
        )}
        <button type="button" onClick={onClose}>
          Chiudi
        </button>
      </div>
    </div>
  );
}
