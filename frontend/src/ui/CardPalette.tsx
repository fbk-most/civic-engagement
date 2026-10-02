import { useState, type CSSProperties } from "react";
import type { CardCategory, CardSpec } from "../api/types";
import { CARD_CATEGORY_LABELS_IT } from "../i18n/labels";
import { CardIcon } from "./cardIcons";
import { CATEGORY_COLORS } from "./categoryColors";

interface Props {
  cards: CardSpec[];
  selected: CardSpec | null;
  onSelect: (card: CardSpec | null) => void;
}

const CATEGORY_ORDER: CardCategory[] = [
  "vegetazione",
  "copertura_suolo",
  "elementi_architettonici",
  "sociale",
];

export function CardPalette({ cards, selected, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const byCategory = CATEGORY_ORDER.map((category) => ({
    category,
    cards: cards.filter((c) => c.category === category),
  })).filter((group) => group.cards.length > 0);

  return (
    <div className="card-palette">
      <button type="button" className="panel-header" onClick={() => setCollapsed((c) => !c)}>
        <h3>Carte</h3>
        <span className="panel-header__chevron">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && byCategory.map(({ category, cards: categoryCards }) => (
        <div key={category} className="card-palette__category">
          <h4 className="card-palette__category-label">{CARD_CATEGORY_LABELS_IT[category]}</h4>
          <div className="card-palette__row">
            {categoryCards.map((card) => (
              <button
                key={card.card_type}
                type="button"
                className={
                  card.card_type === selected?.card_type ? "card-button card-button--selected" : "card-button"
                }
                style={{ "--card-color": CATEGORY_COLORS[category] } as CSSProperties}
                onClick={() => onSelect(card.card_type === selected?.card_type ? null : card)}
              >
                <span className="card-button__icon">
                  <CardIcon cardType={card.card_type} />
                </span>
                <span className="card-button__label">{card.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
