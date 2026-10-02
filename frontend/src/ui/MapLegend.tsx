import { useState } from "react";

// Colors here must stay in sync with the paint expressions in map/layers.ts.
export function MapLegend() {
  // Collapsed by default: it's a reference to look up now and then, not
  // something to keep covering the map.
  const [collapsed, setCollapsed] = useState(true);

  if (collapsed) {
    return (
      <button type="button" className="map-legend map-legend--collapsed" onClick={() => setCollapsed(false)}>
        Legenda ▸
      </button>
    );
  }

  return (
    <div className="map-legend">
      <button type="button" className="panel-header" onClick={() => setCollapsed(true)}>
        <h4>Legenda</h4>
        <span className="panel-header__chevron">▾</span>
      </button>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--tree" />
        Albero
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--stump" />
        Ceppo (abbattuto)
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--bench" />
        Panchina
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--water" />
        Fontana
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--streetlight" />
        Illuminazione
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--pergola" />
        Pergola
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--kiosk" />
        Chiosco
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--playground" />
        Area giochi
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--fitness" />
        Area fitness
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--crossing" />
        Attraversamento pedonale
      </div>
      <div className="map-legend__item">
        <span className="map-legend__swatch map-legend__swatch--traffic-signal" />
        Semaforo
      </div>
    </div>
  );
}
