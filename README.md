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

## Two things cannot stand on the same ground

Every card is refused (409, nothing stored) over what already stands on the
ground it would take; `POST /api/interventions/check` says so in `blocking`,
and `PATCH` re-checks a card whose parameters change (a pergola's size, a
path's width). The rules live in `civic_twin/domains/urban/occupancy.py`, with
their tables (footprint sizes, which cards occupy their whole area) in
`parameters.py`:

- each card has a **footprint**: a point object a small circle (a tree's is its
  trunk, not its canopy), a path its line with its width, an area card its area
  (a garden's with its margin). `change_ground_cover` takes none.
- an object or an area is refused over another object, over the area of a
  garden, grove, playground or fitness area, and over water. Two paths may cross.
- "Coltiva il terreno" clears objects (below), so it is only refused over the
  area of another card, a garden included.
- what is looked at is what stands in the card's year or later, so a card
  cannot be placed under one placed for a later year.
- a replanting does not collide with the stump it replaces.
- the footprint sizes are placeholders. Sessions saved before this rule are
  not re-checked when loaded, and the form's check uses the default
  parameters: a refusal caused by the chosen ones shows when placing.

## Cards that clear their area

Some cards take away what stands on their area before they act on it
(today only "Coltiva il terreno", `cultivate_terrain`). The rules live in one
place, `civic_twin/domains/urban/clearing.py`, and are driven by the tables in
`domains/urban/parameters.py`:

- `CLEARING_CARDS` (in `clearing.py`) lists the cards that clear. Any other
  card is unaffected.
- The card works on the area the user drew **plus a 2 m margin all round**
  (`CULTIVATION_BUFFER_M`, applied only by `cultivation_area()` in `layout.py`),
  so a bench just outside the line is not left standing in the field. The
  check, the clearing, the cover the card places and its cost all start from
  that widened area; the drawn polygon is what is stored. The check returns it
  (`area`, `area_m2`, `margin_m`: the UI prints the margin it is told) and the UI
  outlines it before the card is placed.
- `analyse(layout, area, year)` only *looks*: what would be cleared, what
  blocks it and which covers would be replaced. The check shown to the user
  and the clearing applied to the scenario both come from it, so they cannot
  disagree.
- `CLEARABLE_ELEMENT_TYPES` are removed **whole**, even where they reach beyond
  the area: a path is one long object, so a garden cutting through it removes
  it all. `WARNED_ELEMENT_TYPES` (paths) need a **warning** to be confirmed
  first when part of them lies outside the area.
- `PROTECTED_ELEMENT_TYPES` (buildings, streets...) and `PROTECTED_COVER_TYPES`
  (water: a pond, a lake, a river are all the `water` *cover*, not objects)
  under the area, margin included, **block** it: the user redraws.
- Any other cover under the area is replaced, only where the area is. A cover in
  `CLEARED_COVER_WARNING_TYPES` would also need a **warning** and be filled with
  the cover around it; the table is empty for now, the mechanism is kept for
  covers a new site may add.
- Only what exists at the year of the card is looked at, and what is cleared
  ends in that year (`Entry.end`, `cleared_by`). The model reads the ends, so
  the indicators drop what was cleared.
- The scene still serves cleared *baseline* objects, flagged `cleared_by`:
  the simulation hides them, the views of the situation as it is keep them
  (one rule for every view: `frontend/src/api/visibility.ts`).

Making another card clear is adding it to `CLEARING_CARDS`; a new site's
objects and covers are added to the tables.

Known limits of "Coltiva il terreno":

- Sessions saved before the water block, or with the old `purpose` parameter
  (now `cover_type`), are not re-checked when loaded: one with an area over a
  pond stays as it is, and one with `purpose` falls back to the default cover.
- Prices (5, 30 and 18 €/m² for `crop_field`, `flowerbed`, `vegetable_garden`)
  are placeholders, to be reviewed by a domain expert.
- Crop growth is naive: seasons exist only in 3D (spring and summer grow,
  autumn and winter show bare soil); the 2D map uses a static colour.
- No clearing time or cost is modelled (a stump costs the same as a tree).
- The other cards do not clear their area yet.

## Errors

`POST /api/interventions/check?t=` answers what placing a card would do,
without placing it: `blocking` (what is in the way), `warnings` (to confirm)
and `clearing` (what would be removed). It answers 200 whatever it finds.

The API tells apart three kinds of refusal, each with its own status:

| Status | Meaning | Body (`detail`) |
| --- | --- | --- |
| 404 | The intervention does not exist | a message |
| 422 | The request itself is invalid (a bad `t`, a malformed body, `params` the card's spec does not allow) | a message (for `params`, one line per wrong parameter), or FastAPI's list of validation errors |
| 409 | The request is valid but conflicts with the scene as it is: `POST /api/interventions` over something protected, or raising a warning not listed in `acknowledged_warnings` | the same object as the check's answer |

Both are enforced by the server. **Errors** (`blocking`) always refuse the card.
**Warnings** refuse it until the client lists each one's `key` (for instance
`element_removed_whole:path`) in `acknowledged_warnings` of the create request:
the UI does so once the user has ticked the confirmation. A refused create
stores nothing, and its 409 carries the current check, so a client that never
asked first learns what to confirm.

## Adding a card

A card is a `CardSpec` in `civic_twin/api/routes_cards.py` (its placement and
its parameters) plus what the model does with it (`layout.py`, `encode.py`,
and `clearing.py` if it clears its area).

- **The spec is the one source of what a parameter may be.** Every `params`
  the API receives (check, create, update) is validated against it by
  `validate_params`, **before** anything is stored: a key the card does not
  declare, a select value outside `options`, a number outside `min`/`max` or
  of the wrong type is a 422. Without this a bad value is saved, and every
  later scene request fails on it (or never ends, as with a spacing of 0),
  even after a restart.
- So declare every parameter in the spec, with its `options` or its `min` and
  `max`, and let the layout read `params` without checks of its own. A
  parameter the layout reads but the spec does not declare cannot be set.
- A parameter left out is accepted, and the layout takes its default
  (`params.get(key, default)`): that default must be the spec's.
- `tests/test_params.py` checks that every spec accepts its own defaults,
  options and limits, so a card whose spec contradicts itself fails there.
  Validation is not applied when a session is loaded from disk.

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
