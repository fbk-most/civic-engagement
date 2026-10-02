# Civic Digital Twin (CDT) — PoC

A proof-of-concept tool for citizen co-design workshops on urban space transformation
with nature-based solutions. It reimplements a paper-based method — citizens place
intervention cards (add trees, change ground cover, add water features, ...) on a
printed map — as a 3D digital twin: a facilitator places the same interventions on a
live 3D view of a real site, and the scene plus a set of indicators (CO2, thermal
comfort, accessibility, cost, space use) update immediately.

See `civic_twin/config.py` for the available pilot sites (Piazza Dante, Trento
and Piazza XX Settembre, Bologna) and how the active one is selected. The app
supports one active site per process — switch sites by relaunching with
`CIVIC_TWIN_SITE=<site_id>` (defaults to `piazza_dante`), not live in-session.

## Status

Early PoC, in active development. Milestone build order and design rationale live in
the project's planning notes.

## Backend

Python 3.12, managed with [uv](https://docs.astral.sh/uv/).

```bash
# One-off: fetch OSM data for the active site and build the baseline fixture
# (CIVIC_TWIN_SITE selects the site; defaults to piazza_dante)
uv run python -m civic_twin.ingestion.build_baseline

# Run the API
uv run uvicorn civic_twin.main:app --reload
# Or, for the other site:
CIVIC_TWIN_SITE=piazza_xx_settembre uv run uvicorn civic_twin.main:app --reload

# Tests
uv run pytest
```

The model — tree growth, and the indicators computed over the 30-year
horizon — is a [civic-digital-twins](https://github.com/fbk-most/civic-digital-twins)
model (a dependency installed by uv), in `civic_twin/domains/urban/`. The
backend evaluates it once per set of interventions, for every year at once,
and serves the scene and the indicators for the year asked.

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
cd frontend
npm install
npm run dev     # http://localhost:5173, proxies /api to the backend on :8000
```

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
| `viewer` | `1` | Open on the 3D view. |
| `t` | years, `0`–`30` | Scenario year (as the "Anno" slider). |
| `month`, `day`, `hour` | e.g. `6`, `21`, `22.5` | Date and time for the sun; all three are needed. |
| `lng`, `lat`, `eyeHeight`, `bearing`, `pitch` | degrees / metres | A placed viewpoint (all five needed); opens the 3D view there. |
| `fov` | degrees | Field of view for that viewpoint (optional). |
| `life` | `off`, `still`, `live` | People and traffic: hidden, frozen, moving (default `live`). A `still` link always shows the same picture. |
| `perf` | `1` | Performance readout, with the "Misura" day/night benchmark. |
| `lights` | `all` | Comparison only: a real light for every streetlight, as before the simplified lamp lighting (much slower at night). |
| `realLights` | `1`–`10` | Testing only: how many streetlights near the view get a real, shadow-casting light (default 8). |

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
  `civic_twin/ingestion/lidar.py` and `ortofoto.py`).
