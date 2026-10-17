import { useState } from "react";
import { tr } from "../i18n/lang";

// Colors here must stay in sync with the paint expressions in map/layers.ts.
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
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--tree" />
        {tr("Albero", "Tree")}
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--stump" />
        {tr("Ceppo (abbattuto)", "Stump (felled)")}
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--bench" />
        {tr("Panchina", "Bench")}
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--water" />
        {tr("Fontana", "Fountain")}
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--streetlight" />
        {tr("Illuminazione", "Lighting")}
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--pergola" />
        {tr("Pergola", "Pergola")}
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--kiosk" />
        {tr("Chiosco", "Kiosk")}
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--playground" />
        {tr("Area giochi", "Playground")}
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--fitness" />
        {tr("Area fitness", "Fitness area")}
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--crossing" />
        {tr("Attraversamento pedonale", "Pedestrian crossing")}
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--traffic-signal" />
        {tr("Semaforo", "Traffic light")}
      </div>
    </div>
  );
}
