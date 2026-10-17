import { useState, type CSSProperties } from "react";
import type { CardSpec } from "../api/types";
import { tr } from "../i18n/lang";
import { cardCategoryLabel, cardLabel } from "../i18n/labels";
import { CardIcon } from "./cardIcons";
import { activePack } from "../pack";

interface Props {
  cards: CardSpec[];
  selected: CardSpec | null;
  onSelect: (card: CardSpec | null) => void;
  initiallyCollapsed?: boolean;
}

export function CardPalette({ cards, selected, onSelect, initiallyCollapsed = false }: Props) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  // In the pack's order of the categories.
  const byCategory = activePack()
    .cardCategories.map(({ id, color }) => ({ category: id, color, cards: cards.filter((c) => c.category === id) }))
    .filter((group) => group.cards.length > 0);

  return (
    <div className="card-palette">
      <button type="button" className="panel-header" onClick={() => setCollapsed((c) => !c)}>
        <h3>{tr("Carte", "Cards")}</h3>
        <span className="panel-header__chevron">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && byCategory.map(({ category, color, cards: categoryCards }) => (
        <div key={category} className="card-palette__category">
          <h4 className="card-palette__category-label">{cardCategoryLabel(category)}</h4>
          <div className="card-palette__row">
            {categoryCards.map((card) => (
              <button
                key={card.card_type}
                type="button"
                className={
                  card.card_type === selected?.card_type ? "card-button card-button--selected" : "card-button"
                }
                style={{ "--card-color": color } as CSSProperties}
                onClick={() => onSelect(card.card_type === selected?.card_type ? null : card)}
              >
                <span className="card-button__icon">
                  <CardIcon cardType={card.card_type} />
                </span>
                <span className="card-button__label">{cardLabel(card)}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
