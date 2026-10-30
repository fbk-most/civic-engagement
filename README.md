# civic-engagement — the core of the Civic Digital Twin (CDT)

A proof-of-concept tool for citizen co-design workshops. It reimplements a
paper-based method — citizens place intervention cards (add trees, change
ground cover, plant a forest, ...) on a printed map — as a digital twin: a
facilitator places the same interventions on a live 2D map and 3D view of a
real site, and the scene and a set of indicators update immediately, over
the years of a scenario.

This repository is the **core**: what every domain shares. Each domain is a
**pack** in its own repository, and **is the app**:

| Repository | Domain |
| --- | --- |
| [civic-engagement](https://github.com/fbk-most/civic-engagement) (this one) | the core |
| [bologna-civic-dt](https://github.com/Gemello-Digitale-Bologna/bologna-civic-dt) | urban squares: Piazza Dante (Utopia, an imaginary city built on Trento's data) and Piazza XX Settembre (Bologna) |
| [rural-digital-twin](https://github.com/fbk-most/rural-digital-twin) (private, for now) | a mountain valley's forest: Bocenago (Trentino) |

## Structure: core and domain packs

| | Backend (Python) | Frontend (TypeScript) |
| --- | --- | --- |
| The core | `civic_engagement/` | `frontend/` |

The core holds the API, sessions and scenarios, scene assembly and caching,
indicators as descriptors, the terrain, the 2D map and the 3D view. A pack
holds its domain — sites, cards, model, indicators, ingestion, data — and
builds its app on the core: the API with `create_app(pack)`
(`civic_engagement/app.py`, the pack implementing `DomainPack`,
`civic_engagement/domain.py`) and the interface with `startApp(pack)`
(`frontend/src/index.ts`, the pack implementing `FrontendPack`,
`frontend/src/pack.ts`). The core never imports a pack
(`tests/test_package_boundaries.py` checks it).

A pack depends on a specific commit of the core, for both sides:

```toml
# pyproject.toml
[tool.uv.sources]
civic-engagement = { git = "https://github.com/fbk-most/civic-engagement", rev = "<commit>" }
```

```jsonc
// frontend/package.json
"civic-engagement": "git+https://github.com/fbk-most/civic-engagement.git#<commit>"
```

The npm package is this repository's root `package.json`: the TypeScript
sources (`frontend/src`, compiled by the pack's app) and the static files
(`frontend/public`, served by it). Each pack has a script to move the pin,
or to point it at a local checkout of the core while developing both (see
its README).

A feature often starts in one domain and moves to the core once a second
domain needs it, or the other way round: the felt-temperature field and the
3D life (people, dogs, traffic) are in the core but only the urban pack uses
them; a pack without them turns them off (`FrontendPack.features`).

## Status

Early PoC, in active development. What's still to do is in `TODO.md`, and
in each pack's.

## Backend

Python 3.12, managed with [uv](https://docs.astral.sh/uv/).

```bash
uv sync
uv run pytest      # on a toy pack (tests/toy_pack): the core alone
```

The core runs only as part of a pack's app, one site per process: the pack
lists its sites, and `CIVIC_ENGAGEMENT_SITE=<site_id>` chooses one when the
backend starts (the pack's default otherwise). Each site's files live under
`data/<site>/`, relative to where the backend runs: the baseline, the
session, the scenarios, the terrain grid.

The workshop's cards (the session) live in the backend, shared by every open
window, and are mirrored to `data/<site>/session.json`. A set of cards can be
saved under a name as a *scenario*, in `data/<site>/scenarios/<id>.json`, and
loaded back later in place of the session — from the "Scenarios" menu, or
through the API (`GET /api/scenarios`, `POST /api/scenarios`,
`POST /api/scenarios/{id}/load`, `DELETE /api/scenarios/{id}`;
`POST /api/session/clear` starts again with no cards). Whatever a load
replaces is kept as `data/<site>/session.<timestamp>.json`.
`CIVIC_ENGAGEMENT_SCENARIO=<id>` loads a scenario when the backend starts — at
every start, `--reload` restarts included, so leave it out once a workshop
is under way.

`CIVIC_ENGAGEMENT_STATE=<directory>` keeps the session and the saved
scenarios elsewhere (`civic_engagement/store/storage.py`), under
`<directory>/data/<site>/`: for a container whose own files are read-only;
or `s3://<bucket>/<prefix>`, in a bucket (the core's `s3` extra; the
credentials `CIVIC_ENGAGEMENT_S3_ACCESS_KEY` and
`CIVIC_ENGAGEMENT_S3_SECRET_KEY`, the endpoint
`CIVIC_ENGAGEMENT_S3_ENDPOINT`, or else the standard `AWS_*` variables; on
DigitalHub, `CIVIC_ENGAGEMENT_S3_CREDENTIALS=digitalhub` and the `dh`
extra: the run's own, renewed through the platform's SDK,
`civic_engagement/digitalhub.py`). The site's preset scenarios, in
`data/<site>/scenarios/`, are offered beside the saved ones, and can't be
deleted.

### Teams

All of the above is the app as it runs by default, with no login
(`CIVIC_ENGAGEMENT_AUTH=open`): one team, everyone an editor. With
`CIVIC_ENGAGEMENT_AUTH=pin`, several teams work on the same site, each with
its own scene and scenarios: a member opens the app on a PIN screen, and the
PIN says the team and the role — an editor changes the scene, a viewer
looks at it, with their own year, date and point of view. A manager sets
the teams up and hands out the PINs, with `civic-engagement-admin`
(`civic_engagement/access.py` says how access works, `api/routes_admin.py`
what the manager can do).

```bash
CIVIC_ENGAGEMENT_AUTH=pin \
CIVIC_ENGAGEMENT_PIN_SECRET=<16 or more random characters, the same across restarts> \
CIVIC_ENGAGEMENT_MANAGER_USER=manager CIVIC_ENGAGEMENT_MANAGER_PASSWORD=<12 or more characters> \
  uv run uvicorn <pack>.main:app

export CIVIC_ENGAGEMENT_ADMIN_URL=http://localhost:8000 \
  CIVIC_ENGAGEMENT_MANAGER_USER=manager CIVIC_ENGAGEMENT_MANAGER_PASSWORD=<password>
uv run civic-engagement-admin team create "Team 1"
uv run civic-engagement-admin member add team-1 "Anna" --editor    # prints Anna's PIN
uv run civic-engagement-admin member add team-1 --viewers          # the team's viewers' PIN
```

Wrong PINs are throttled per client IP (10 a minute free, then waits of up
to a minute) and across the site (beyond 60 a minute, everyone waits); the
manager's wrong passwords apart, so that PINs never hold the manager up.
`civic-engagement-admin status` shows who's waiting,
`civic-engagement-admin throttle reset [<ip>]` lets them try again at once.

`CIVIC_ENGAGEMENT_TRUSTED_PROXY` tells the throttling where the client's IP
is: 0, the connection's — only when clients connect straight to the app;
1, the one a gateway adds to `X-Forwarded-For`, if it's the client's;
unset (the default), nowhere: only the site-wide limit. Behind Docker's
port forwarding, or a gateway that passes on an address of its own, every
client looks the same: leave it unset, or one participant's typos hold
everyone up.

### In a container

A pack's image runs its app with the core's launcher, on port 8080:

```bash
python -m civic_engagement.serve bologna_civic_dt.main:app
```

It sizes the native libraries' threads (OpenMP, OpenBLAS) to the CPUs the
process may use: `CIVIC_ENGAGEMENT_CPUS`, or else the container's CPU quota
(`civic_engagement.config.cpus`, also for a pack's own thread pools). In a
container, the CPU count is the machine's, not the quota's.
`CIVIC_ENGAGEMENT_HOST` and `CIVIC_ENGAGEMENT_PORT` change where it listens.

`CIVIC_ENGAGEMENT_FRONTEND=<directory>`, the pack's built app (its
`frontend/dist`), has the backend serve it at `/`, beside the API: one
origin, no Vite. `GET /api/health` says the backend is up.

How a pack's app is delivered on the DigitalHub platform:
[docs/deploy-digitalhub.md](docs/deploy-digitalhub.md).

The pack's model is evaluated once per set of interventions, for every year
of the horizon at once; the backend serves the scene and the indicators for
the year asked.

A site can have **terrain**: a height grid built from a LiDAR DTM
(`civic_engagement/ingestion/terrain.py`), in `data/<site>/terrain/terrain_grid.json`,
served as a site asset (`/api/site-assets`). The 3D view then lays
everything on it, and the camera and walk mode follow it; a site without
the file is flat. `?terrain=off` shows a site flat, for comparison.

## Frontend

Vite + React + TypeScript. MapLibre GL JS for the plan view, three.js for the
realistic view.

```bash
npm install
npm run typecheck && npm run lint
npm run dev     # the tree lab only, http://localhost:5173/tree-lab.html: the apps are the packs'
```

For workshops, demos and performance measurements, use a pack's production
build (`npm run build && npm run preview` in its `frontend/`), not its
development server: the development build is much slower in the 3D view.
React's development mode records every component render for the browser's
performance panel, diffing their props, and the 3D view's props are large
(the scene, the felt-temperature fields): a date change measured about
2.5 s in development, almost all of it that bookkeeping.

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

A forest — trees by the hundred thousand — comes from a pack's tree source
(`FrontendPack.scene3d.treeSource`, `frontend/src/three/builders/forest.ts`),
drawn in tiles, with shadows near the camera.

All 3D assets are CC0 and vendored under `frontend/public/assets/3d/` (see the
`CREDITS.md` there), so the tool needs no network at workshop time. The scripts
that regenerate them live in `scripts/` and `frontend/scripts/`.

### URL parameters

The frontend reads a few optional parameters from its URL (see
`frontend/src/debugParams.ts`), e.g.
`http://localhost:5173/?viewer=1&month=6&day=21&hour=22.5&life=still&perf=1`.
"Copia URL vista" in the 3D view builds such a link for the current view. A
pack may read its own: see its README.

| Parameter | Values | Effect |
| --- | --- | --- |
| `lang` | `it`, `en` | Interface language (default: the last one chosen with the IT/EN switch, else English). |
| `temp` | `C`, `F` | Temperature unit, for display only: the model works in °C (default: the last one chosen with the °C/°F switch, else Celsius). The switch shows only in packs with the felt-temperature field. |
| `viewer` | `1` | Open on the 3D view. |
| `t` | years | Scenario year (as the "Anno" slider). |
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
| `terrain` | `off` | Comparison only: draw the site flat, even if it has a terrain grid. |
| `terrainScale` | e.g. `3` | Testing only: the terrain's heights multiplied by this, to see it on gentle ground. |
| `treeFar` | metres | Testing only: beyond this distance from the camera, a forest's trees are thinned out to a tenth, with wider crowns (default: never). |
| `treeShadows` | metres, or `off` | Testing only: how far from the camera a forest's trees cast shadows (default `1200`); `off`, nowhere. |
| `depth` | `reversed`, `log` | Testing only: the depth buffer, whatever the pack's choice (`scene3d.reversedDepth`). Reversed needs the browser's `EXT_clip_control` (the console says which one is used) and breaks the reflection of water (three's `Water.js`). |

The active site is not a URL parameter: it's chosen when starting the backend
(`CIVIC_ENGAGEMENT_SITE`, see above).

## Licence

The code is released under the [Apache License 2.0](LICENSE). The vendored
3D assets are CC0; see `frontend/public/assets/3d/CREDITS.md`. The sites'
data, and its sources, are the packs'.
