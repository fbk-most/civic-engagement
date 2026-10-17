import { useState } from "react";
import { tr } from "../i18n/lang";
import { activePack } from "../pack";

/** The 2D map's legend: the pack's (`FrontendPack.map.legend`). */
export function MapLegend() {
  // Collapsed by default: it's a reference to look up now and then, not
  // something to keep covering the map.
  const [collapsed, setCollapsed] = useState(true);

  if (collapsed) {
    return (
      <button type="button" className="map-legend map-legend--collapsed" onClick={() => setCollapsed(false)}>
        {tr("Legenda", "Legend")} ▸
      </button>
    );
  }

  return (
    <div className="map-legend">
      <button type="button" className="panel-header" onClick={() => setCollapsed(true)}>
        <h4>{tr("Legenda", "Legend")}</h4>
        <span className="panel-header__chevron">▾</span>
      </button>
      {activePack().map.legend.map(({ label, swatch }) => (
        <div key={label[0]} className="map-legend__item">
          <span className="map-legend__swatch" style={swatch} />
          {tr(...label)}
        </div>
      ))}
    </div>
  );
}
