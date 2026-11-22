import { useState, type CSSProperties } from "react";
import type { CardSpec, Intervention } from "../api/types";
import { tr } from "../i18n/lang";
import { cardLabel, summarizeParams, yearLabel } from "../i18n/labels";
import { CardIcon } from "./cardIcons";
import { categoryColor } from "./categoryColors";

interface Props {
  interventions: Intervention[];
  cards: CardSpec[];
  onSelect: (id: string) => void;
  initiallyCollapsed?: boolean;
}

function InterventionRow({ iv, cards, onSelect }: { iv: Intervention; cards: CardSpec[]; onSelect: (id: string) => void }) {
  const card = cards.find((c) => c.card_type === iv.card_type);
  const color = card ? categoryColor(card.category) : "#999";
  return (
    <div className="intervention-card" style={{ "--card-color": color } as CSSProperties}>
      <button type="button" className="intervention-card__header" onClick={() => onSelect(iv.id)}>
        <span className="intervention-card__icon">{card && <CardIcon cardType={card.card_type} />}</span>
        <span className="intervention-card__text">
          <span className="intervention-card__label">
            {card ? cardLabel(card) : iv.card_type}
            <span className="intervention-card__year"> · {yearLabel(iv.planted_year)}</span>
          </span>
          <span className="intervention-card__summary">{summarizeParams(card, iv.params)}</span>
        </span>
      </button>
    </div>
  );
}

export function InterventionList({ interventions, cards, onSelect, initiallyCollapsed = false }: Props) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  // The policies (cards without a place) apart, after those on the map.
  const isPolicy = (iv: Intervention) => cards.find((c) => c.card_type === iv.card_type)?.placement_type === "none";
  const placed = interventions.filter((iv) => !isPolicy(iv));
  const policies = interventions.filter(isPolicy);

  return (
    <div className={collapsed ? "intervention-list intervention-list--collapsed" : "intervention-list"}>
      <button type="button" className="panel-header" onClick={() => setCollapsed((c) => !c)}>
        <h3>{tr("Interventi inseriti", "Placed interventions")}</h3>
        <span className="panel-header__chevron">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <>
          {interventions.length === 0 && (
            <p className="intervention-list__empty">
              {tr("Nessuno ancora — scegli una carta e disegna sulla mappa.", "None yet — pick a card and draw on the map.")}
            </p>
          )}
          {placed.map((iv) => (
            <InterventionRow key={iv.id} iv={iv} cards={cards} onSelect={onSelect} />
          ))}
          {policies.length > 0 && <h4 className="intervention-list__group">{tr("Politiche", "Policies")}</h4>}
          {policies.map((iv) => (
            <InterventionRow key={iv.id} iv={iv} cards={cards} onSelect={onSelect} />
          ))}
        </>
      )}
    </div>
  );
}
