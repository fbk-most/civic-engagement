# Civic Digital Twin (CDT) — PoC

A proof-of-concept tool for citizen co-design workshops on urban space transformation
with nature-based solutions. It reimplements a paper-based method — citizens place
intervention cards (add trees, change ground cover, add water features, ...) on a
printed map — as a 3D digital twin: a facilitator places the same interventions on a
live 3D view of a real site, and the scene plus a set of indicators (CO2, thermal
comfort, accessibility, cost, space use) update immediately.

See `packs/bologna-civic-dt/bologna_civic_dt/sites.py` for the available pilot sites (Piazza Dante, Utopia
— an imaginary city, built on the data of Piazza Dante in Trento — and Piazza
XX Settembre, Bologna) and how the active one is selected. The app
supports one active site per process — switch sites by relaunching with
`CIVIC_TWIN_SITE=<site_id>` (defaults to `piazza_dante`), not live in-session.

## Structure: core and domain packs

The code is split into a **core** and **domain packs**, which will move to
separate repositories:

| | Backend (Python) | Frontend (TypeScript) |
| --- | --- | --- |
| Core, `civic-engagement` | `civic_engagement/` | `frontend/` |
| Urban pack, `bologna-civic-dt` | `packs/bologna-civic-dt/bologna_civic_dt/` | `packs/bologna-civic-dt/frontend/` |

The core holds what every domain shares: the API, sessions and scenarios,
scene assembly and caching, indicators as descriptors, the 2D map and the
3D view. A pack holds its domain — sites, cards, model, indicators,
ingestion — and **is the app**: it builds the API with the core's
`create_app(pack)` (`civic_engagement/app.py`) and the interface with its
`startApp(pack)` (`frontend/src/index.ts`). The core never imports a pack
(`tests/test_package_boundaries.py` checks it).

A feature often starts in one domain and moves to the core once a second
domain needs it: the felt-temperature field and the 3D life (people, dogs,
traffic) are urban for now. The 3D models and textures are all still under
`frontend/public/`, which the urban app serves; how they split between
the core and the packs is to be decided when a second domain needs its own.

## Status

Early PoC, in active development. Milestone build order and design rationale live in
the project's planning notes.

## Backend

Python 3.12, managed with [uv](https://docs.astral.sh/uv/).

```bash
# One-off: fetch OSM data for the active site and build the baseline fixture
# (CIVIC_TWIN_SITE selects the site; defaults to piazza_dante)
uv run python -m bologna_civic_dt.ingestion.build_baseline

# Run the API
uv run uvicorn bologna_civic_dt.main:app --reload
# Or, for the other site:
CIVIC_TWIN_SITE=piazza_xx_settembre uv run uvicorn bologna_civic_dt.main:app --reload

# Start from a saved scenario instead of the last session (see below)
CIVIC_TWIN_SCENARIO=demo uv run uvicorn bologna_civic_dt.main:app

# Tests
uv run pytest
```

The workshop's cards (the session) live in the backend, shared by every open
window, and are mirrored to `data/<site>/session.json`. A set of cards can be
saved under a name as a *scenario*, in `data/<site>/scenarios/<id>.json`, and
loaded back later in place of the session — from the "Scenarios" menu, or
through the API (`GET /api/scenarios`, `POST /api/scenarios`,
`POST /api/scenarios/{id}/load`, `DELETE /api/scenarios/{id}`;
`POST /api/session/clear` starts again with no cards). Whatever a load
replaces is kept as `data/<site>/session.<timestamp>.json`.
`CIVIC_TWIN_SCENARIO=<id>` loads a scenario when the backend starts — at
every start, `--reload` restarts included, so leave it out once a workshop
is under way.

The model — tree growth, and the indicators computed over the 30-year
horizon — is a [civic-digital-twins](https://github.com/fbk-most/civic-digital-twins)
model (a dependency installed by uv), in `packs/bologna-civic-dt/bologna_civic_dt/`. The
backend evaluates it once per set of interventions, for every year at once,
and serves the scene and the indicators for the year asked.

Felt temperature is a second model (`packs/bologna-civic-dt/bologna_civic_dt/thermal_field.py`):
a 1 m grid over the site, hour by hour through one day, from the shade of
buildings, trees and pergolas (real sun position for the date), the ground's
surface and a typical day's air temperature for Trento, warming over the
years by a climate assumption (a summer like 2022 becomes the usual one in
ten years, see `CLIMATE_WARMING_C`). It is evaluated on
demand — `GET /api/thermal-field?t=&month=&day=` — and its values at a
reference moment (21 June, 11:00) are the thermal indicators. A cheap,
uncalibrated proxy: see `parameters.py`.

`tests/test_reference.py` checks that what the backend serves is unchanged
against outputs recorded in `tests/fixtures/reference/`, for both sites. It
is temporary: it guards the restructuring of the model and goes once that is
over. When a change is meant to alter the numbers, re-record the reference
with `CIVIC_TWIN_SITE=<site_id> uv run python -m tests.reference.capture`
(once per site) and review the differences before committing.

## Frontend

Vite + React + TypeScript. MapLibre GL JS for the plan view, three.js for the
realistic view.

```bash
npm install     # once, at the repository root: npm workspaces for the core
                # (frontend/) and the urban app (packs/bologna-civic-dt/frontend/)
npm run dev     # the urban app on http://localhost:5173, proxies /api to the backend on :8000
npm run typecheck && npm run lint   # both workspaces
```

The core's own dev server (`cd frontend && npm run dev`) serves only the
tree lab, `/tree-lab.html`.

For workshops, demos and performance measurements, use the production build
instead:

```bash
npm run build && npm run preview   # http://localhost:4173, same proxy
```

The development build is much slower in the 3D view: React's development
mode records every component render for the browser's performance panel,
diffing their props, and the 3D view's props are large (the scene, the
felt-temperature fields). A date change measured about 2.5 s in development,
almost all of it that bookkeeping.

### Realistic 3D view

Alongside the stylized plan view, the tool renders the same model as a lit,
textured, eye-level scene:

- **Posiziona un punto di vista** — click where a person stands, then in the
  direction they face. The field of view appears on the map as a wedge, and the
  3D panel opens at that viewpoint.
- **Cammina nello spazio** — first-person walk at 1.65 m eye height (WASD or
  arrows, Shift to run, Esc to exit). You can't walk through buildings.
- **Sun control** — real solar position for the site's latitude at a chosen
  date and time of day. This is a *different* axis from the scenario time
  slider: the slider moves the proposal forward in years, the sun control moves
  the clock within a year. Shadows are the point — the indicators panel argues
  about shade numerically, and this shows the same argument.
- **Salva immagine** — PNG export of the current view, for the workshop record.

The view is labelled *Visualizzazione indicativa* throughout: in a citizen
workshop a realistic image is easily read as a promise about what will be built.

Building geometry sits behind a `BuildingGeometryProvider` interface
(`frontend/src/three/builders/buildings.ts`). The PoC extrudes OSM footprints;
LiDAR-derived LOD2 solids or streamed photogrammetry tiles can replace that one
implementation without touching ground, paths, vegetation or lighting.

All 3D assets are CC0 and vendored under `frontend/public/assets/3d/` (see the
`CREDITS.md` there), so the tool needs no network at workshop time. The scripts
that regenerate them live in `scripts/`.

### URL parameters

The frontend reads a few optional parameters from its URL (see
`frontend/src/debugParams.ts`), e.g.
`http://localhost:5173/?viewer=1&month=6&day=21&hour=22.5&life=still&perf=1`.
"Copia URL vista" in the 3D view builds such a link for the current view.

| Parameter | Values | Effect |
| --- | --- | --- |
| `lang` | `it`, `en` | Interface language (default: the last one chosen with the IT/EN switch, else English). |
| `viewer` | `1` | Open on the 3D view. |
| `t` | years, `0`–`30` | Scenario year (as the "Anno" slider). |
| `month`, `day`, `hour` | e.g. `6`, `21`, `22.5` | Date and time for the sun; all three are needed. |
| `lng`, `lat`, `eyeHeight`, `bearing`, `pitch` | degrees / metres | A placed viewpoint (all five needed); opens the 3D view there. |
| `fov` | degrees | Field of view for that viewpoint (optional). |
| `life` | `off`, `still`, `live` | People and traffic: hidden, frozen, moving (default `live`). A `still` link always shows the same picture. |
| `perf` | `1` | Performance readout, with the "Measure" day/night and "Responsiveness" benchmarks. |
| `lights` | `all` | Comparison only: a real light for every streetlight, as before the simplified lamp lighting (much slower at night). |
| `realLights` | `1`–`10` | Testing only: how many streetlights near the view get a real, shadow-casting light (default 8). |
| `thermal` | `1` | Open with the felt-temperature panel open and its field drawn on the ground. |
| `panels` | `closed` | Open with the side boxes (cards, interventions, key indicators) collapsed. |
| `interventions` | `attuale`, `carte`, `simulazione` | Open on "Situazione attuale", "Carte proposte" or "Simulazione" (default). |
| `comfort` | `off` | Comparison only: people ignore the felt temperature (by default they stop less, and walk less, where it's very hot or cold). |

The active site is not a URL parameter: it's chosen when starting the backend
(`CIVIC_TWIN_SITE`, see above).

## Licence and data sources

The code is released under the [Apache License 2.0](LICENSE). The vendored
3D assets are CC0; see `frontend/public/assets/3d/CREDITS.md`.

The site baselines (`data/*/baseline.json`) are derived from third-party
data:

- **OpenStreetMap**: buildings, streets, paths, trees, street furniture and
  ground covers for both sites. © OpenStreetMap contributors, available
  under the [Open Database License](https://www.openstreetmap.org/copyright).
- **Provincia autonoma di Trento**: building heights and roof shapes for
  Piazza Dante from the 2014 LiDAR survey, and roof colours from the 2015
  orthophoto. The source rasters are not in the repository (see
  `civic_engagement/ingestion/lidar.py` and `ortofoto.py`).
