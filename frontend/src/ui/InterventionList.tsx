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
  /** Turns a card on or off: given to those who may change the cards now
   * (the others see which are off, but no switch). */
  onToggle?: (id: string, enabled: boolean) => void;
  initiallyCollapsed?: boolean;
}

export function InterventionList({ interventions, cards, onSelect, onToggle, initiallyCollapsed = false }: Props) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);

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
          {interventions.map((iv) => {
            const card = cards.find((c) => c.card_type === iv.card_type);
            const color = card ? categoryColor(card.category) : "#999";
            const className = iv.enabled ? "intervention-card" : "intervention-card intervention-card--off";
            return (
              <div key={iv.id} className={className} style={{ "--card-color": color } as CSSProperties}>
                <button type="button" className="intervention-card__header" onClick={() => onSelect(iv.id)}>
                  <span className="intervention-card__icon">
                    {card && <CardIcon cardType={card.card_type} />}
                  </span>
                  <span className="intervention-card__text">
                    <span className="intervention-card__label">
                      {card ? cardLabel(card) : iv.card_type}
                      <span className="intervention-card__year"> · {yearLabel(iv.planted_year)}</span>
                    </span>
                    <span className="intervention-card__summary">
                      {!iv.enabled && !onToggle && `${tr("Non selezionato", "Not selected")} · `}
                      {summarizeParams(card, iv.params)}
                    </span>
                  </span>
                </button>
                {onToggle && (
                  <input
                    type="checkbox"
                    className="intervention-card__switch"
                    checked={iv.enabled}
                    title={
                      iv.enabled
                        ? tr("Selezionato: togli dalla simulazione", "Selected: leave out of the simulation")
                        : tr("Non selezionato: rimetti nella simulazione", "Not selected: put back in the simulation")
                    }
                    onChange={(e) => onToggle(iv.id, e.target.checked)}
                  />
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
