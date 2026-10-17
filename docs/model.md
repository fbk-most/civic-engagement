# Physical and social city models for urban co-design

This is a guide to building a digital twin that supports citizens in co-designing an urban
space. Such a twin brings together a **physical model** of the city (what is there, how it
changes, what it does to the climate and the environment) and a **social model** (who uses the
space, how, and how they fare in it). It explains which layers such a twin needs, what each
layer is responsible for, how the layers connect, and which design choices matter when the twin
is used in a workshop with citizens.

The guide is grounded in a working reference implementation, this repository, built for
workshops on nature-based solutions in two squares: Piazza Dante in Utopia, an imaginary city
built on the data of Piazza Dante in Trento, and Piazza XX Settembre in Bologna. Each section
first states the general idea and then shows how the reference implementation realizes it (*In the reference implementation*). These parts point to
code; they are examples, not prescriptions.

The guide is about architecture. The detailed models (growth curves, thermal coefficients,
behaviour curves) are deliberately simple placeholders and are only sketched.

## 1. Why bring physical and social models together

Co-design workshops on public space often use a paper method. Citizens place cards (plant a
tree, add a bench, turn asphalt into a meadow) on a printed map of the site and discuss the
result. The method is accessible and good at starting a discussion. However, it leaves the
consequences of a proposal to everyone's imagination: what the place will look like, whether it
will be pleasant on a July afternoon, who will use it, what it will cost.

A digital twin can answer those questions while the discussion is still going on. Physical and
social questions are inseparable in co-design, though:

- A tree is a physical object. It grows, casts shade and stores carbon. Its value to the
  discussion is social: it gives people a cooler place to sit.
- A streetlight changes how much of the site is lit, which is a physical quantity. That matters
  because of who feels safe crossing the square at night, which is a social quantity.
- A heat map of felt temperature is correct but abstract. People avoiding the sunny half of the
  square and crowding under the trees show the same information in a way everyone understands.

The twin should therefore treat the physical model as the source of truth about the place. The
social model should read from it and make its consequences visible, and both should be shown in
the same views, with the same time controls and the same comparison against the current state.

## 2. Design principles

These principles shape every layer below. Most of them come from the workshop setting rather than
from technology.

1. **What-if, never destructive.** The existing site (the *baseline*) is never modified. A
   proposal is the baseline plus a list of interventions, and it is always shown next to the
   "as is" scenario. Every edit can be undone, and the comparison is always available.
2. **Indicative, not predictive.** In a citizen workshop a realistic image or a precise number is
   easily read as a promise. Models are cheap proxies, numbers are compared against "as is" rather
   than read in absolute terms, and realistic views are explicitly labelled as indicative.
3. **Explainable.** A facilitator must be able to say in one sentence why a number changed or why
   people moved. Prefer simple, monotone relations, such as "more canopy means more shade, which
   means cooler", over opaque simulations.
4. **Reproducible.** The same proposal, year, date and hour must always give the same numbers and
   the same picture, people included. Randomness should be seeded from stable identifiers. A view
   can then be shared as a link, and two proposals can be compared fairly.
5. **One model, many views.** The 2D map, the 3D view and the charts are all derived from the same
   resolved model. No view keeps state of its own about the site.
6. **Responsive enough for a conversation.** A change must show up while the discussion is still
   about it, within about a second. This constrains model design as much as accuracy does
   (sections 6, 7 and 10).
7. **Self-contained at workshop time.** Venues have unreliable networks. Site data, assets and
   models are prepared in advance and run locally.

## 3. Architecture overview

### Layers

The architecture has seven layers. Each layer reads only from the layers above it, except the
views, which read from all of them.

| # | Layer | Responsibility |
| --- | --- | --- |
| 1 | **City model** | The site as data: discrete elements (buildings, trees, benches, …) and continuous covers (paving, lawn, water) |
| 2 | **Interventions** | The co-design language: cards that add, remove or transform elements, as deltas on the baseline |
| 3 | **Physical model** | How a scenario evolves over the years: growth, carbon, costs, coverage. Evaluated as a whole scenario on a modelling framework |
| 4 | **Spatial fields** | Quantities that vary across the site and through the day, such as felt temperature: the bridge between physical and social |
| 5 | **Social model** | Who is in the space, where they stay, how they move, and how they fare, driven by the fields |
| 6 | **Indicators** | Numbers that summarize a scenario, always paired with the "as is" values |
| 7 | **Views and interaction** | 2D map, 3D view and charts, plus the controls the facilitator uses to place cards and move in time |

### Data flow

```
            offline                         per edit / per request                      in the browser
 ┌───────────────────────────┐
 │ open data ─▶ city model   │ (1)
 └───────────────────────────┘
               │
 cards ─▶ interventions (2) ─▶ scenario ─▶ physical model (3) ─▶ element state + indicators (6)
                                              │                      │
                                              ▼                      │
                                   spatial fields (4) ───────────────┤
                                     │                               │
                                     ▼                               ▼
                               social model (5) ───────────▶  views (7): 2D · 3D · charts
```

### Time

A co-design twin needs more than one notion of time. The axes should be kept separate in the
model and in the interface:

| Axis | Question it answers | Typical range |
| --- | --- | --- |
| **Scenario year** | "What will this place be like in 10 years?" | 0–30 years |
| **Calendar date and hour** | "Will I be able to sit here on a July afternoon? Is it safe at night?" | any day and hour |
| **Season** | Derived from the date: leaves on or off, light, weather | — |

When two controls can both claim to say which year it is, the facilitator cannot explain what is
on screen. Choose one owner for each axis.

*In the reference implementation:* the scenario year `t` runs from 0 to 30 (`HORIZON_YEARS`).
The sun control sets month, day and hour, and the calendar year is always the current year plus
`t` (`frontend/src/three/sun.ts`, `civic_engagement/scene.py`).

## 4. Layer 1: the city model

The city model is the digital representation of the site before any proposal. It should keep two
kinds of data apart from the start:

- **Discrete elements**: identifiable objects with a type, a geometry and properties. A tree has a
  species and a size, and a bench has a position. Interventions target these objects, and the
  social model uses them as places (a seat, a destination).
- **Continuous covers**: what the ground is made of, as regions. Interventions transform them by
  overlay ("turn this area into meadow"), and physical models read them as surface properties.

Every element records its **origin**, baseline or a particular intervention, so that views can
distinguish what exists from what is proposed.

The city model is built **offline** from open data. It is normal for that data to be incomplete.
OpenStreetMap rarely records tree species or ages, and road markings may be missing. Fill the
gaps explicitly, for example with seeded plausible values, and record which values are invented.
These gaps matter later: a tree-disease scenario is meaningless if the species are made up.

*In the reference implementation:* the site registry is `civic_engagement/config.py`, with one active
site per process. Ingestion lives in `civic_engagement/ingestion/`. It combines OSM (buildings, streets,
paths, trees, furniture, covers), LiDAR building heights and roof shapes and orthophoto roof
colours (Piazza Dante only), and road markings inferred from OSM. The result is `data/<site>/baseline.json`
with 14 element types and 9 cover types (`civic_engagement/models/schema.py`). Baseline trees get a
seeded species, age class and cut year (`bologna_civic_dt/trees.py`).

## 5. Layer 2: interventions, the co-design language

Interventions are the vocabulary citizens use to express proposals, so they should mirror the
physical cards of the workshop method. Each intervention needs:

- a **card type** and **category** (vegetation, ground cover, architectural elements, social),
  which the views use for colour and grouping;
- a **placement geometry**: a point (a tree, a bench), a line (a path) or an area (a grove, a
  playground);
- a few **parameters** (species, material, size), kept to what a citizen can reasonably decide;
- a **start year**, because a proposal is "if we do this in year N". It must not appear in earlier
  years, and it should start growing in year N.

Interventions are stored as an **append-only list with soft deletes**, on top of the untouched
baseline. Expanding a card into what it puts on the site is the job of one module. For example,
a grove card becomes a lawn plus scattered young trees. Every other layer then sees only elements
and covers, never cards. The same session record is what organizers take home after the workshop.

Card specifications should be data, not code, so that the views can build palettes and forms from
them and a new card does not require frontend work.

*In the reference implementation:* there are ten cards (`civic_engagement/api/routes_cards.py`), from
"plant a tree" to "fitness area". Cards are expanded and the timing rules are applied in
`bologna_civic_dt/layout.py`, which is the single place that does so. The session store
(`civic_engagement/store/state.py`) is in memory and mirrored to one JSON file per site, for a single
facilitator making sequential edits.

## 6. Layer 3: the physical model

### Model a scenario, not a state

The physical model answers: *given the baseline and these interventions, what happens over the
coming years?* Two architectural choices make this tractable.

- **Evaluate the whole horizon at once.** One evaluation per scenario computes every year. Moving
  the year slider then only reads another year from the result, which keeps the most frequent
  interaction instant.
- **Treat "as is" as just another scenario.** The model needs no notion of a baseline.
  Comparison is done by the caller, which evaluates the empty scenario once and pairs every
  response with it.

### Use a modelling framework

Writing the model as a declared computation graph rather than ad-hoc code has concrete benefits:

- **Parameters are first-class.** Every coefficient (growth rate, carbon per m², price) is a model
  parameter that a scenario can override. This is the basis for "what if the climate is hotter",
  "what if this species is diseased", or ensembles under uncertainty.
- **Sub-models are explicit.** Each concern (growth, carbon, accessibility, costs, social coverage,
  space use) is a separate component with declared inputs and outputs, wired together explicitly.
  New concerns are added without touching existing ones.
- **The model returns state as well as indicators.** The size and status of every tree in every
  year come from the model, so the 3D view and the indicators cannot disagree.
- **Domain-independent.** The same framework can host a forestry model or a mobility model next to
  the urban one.

Converting the scenario into model inputs is a separate step: list what exists, where and from
when, then encode it as arrays on the model's axes. That step is the only place that knows both
the city model's vocabulary and the model's input format.

*In the reference implementation:* the model uses the
[civic-digital-twins](https://github.com/fbk-most/civic-digital-twins) framework (`Model`,
`Index`, `Scenario`, functors). The pipeline is `layout.py` (what, where, when), then `encode.py`
(arrays), then `UrbanModel` in `model.py`. `UrbanModel` connects six sub-models: `TreeGrowth`,
`Carbon`, `Accessibility`, `Costs`, `Social` and `SpaceUse`. All coefficients are in
`parameters.py`. Spatial computations that the graph cannot express, such as lit area and cover
overlaps, are functors over Shapely (`geometry.py`). Workarounds for current framework limits,
such as empty axes and geometry passed as bytes, are collected in `cdt_compat.py` as candidates
for improving the framework. `civic_engagement/scene.py` caches the evaluation and pairs it with "as is".

## 7. Layer 4: spatial fields, the bridge

Many of the questions citizens ask depend on **where** and **when**. "Is it hot?" depends on which
corner of the square and which hour. A single scalar per year cannot answer them, so the twin
needs **spatial fields**: grids over the site, through the day, computed from the resolved
scenario.

Fields are the natural interface between the physical and the social models:

- The physical side produces them from the scene: shade from buildings and canopies, surface
  materials, water, sun position and weather for the date.
- The social side consumes them: people stay where it is comfortable and walk where it is pleasant.
- The views draw them as semi-transparent layers, in 2D and in 3D, on one shared colour scale.
- Their summaries become indicators, such as the share of the open space in heat stress at a
  reference moment.

Fields are more expensive than yearly series, so they are evaluated **on demand** for a given
scenario, year and date, cached, and prefetched for likely next requests. Indicators that need a
field over all years can sample it every few years and interpolate.

Felt temperature is the first field. Others follow the same pattern: perceived safety or lighting
at night, noise, accessibility. Each new field gives the social model one more thing to react to.

*In the reference implementation:* felt temperature (`bologna_civic_dt/thermal_field.py`) is a second
civic-digital-twins model on a 1 m grid with 24 hourly layers. `field_grid.py` turns the scene into
rasters, and `solar.py` provides the real sun position, a typical daily air-temperature curve and
leaf density. A ray-casting functor computes sun exposure through buildings, crowns and pergolas.
`GET /api/thermal-field` serves the field quantized to one byte per cell, and the backend keeps
recent fields in a cache. The thermal indicators read the field at a reference moment (21 June,
11:00). The views share a colour scale anchored on the UTCI stress bands
(`frontend/src/thermal/field.ts`).

## 8. Layer 5: the social model

### What it is for

The social model populates the space with people and shows how a proposal changes the use of the
space: where people sit, which way they walk, who comes and who stays away. Its job in a workshop
is to make the physical consequences tangible. A cool spot under new trees that fills with people
on a July afternoon makes the case better than a number does.

### Illustration, not simulation

A social model in a co-design twin should be honest about what it is. It is an **illustration of
typical use**, consistent with the physical model, not a forecast of attendance. Agent-based
simulation can reach for far more, but it costs explainability, reproducibility and
responsiveness, which section 2 puts first. A practical structure:

1. **Activity level**: how busy the space is, as a simple function of the hour, the season and
   daylight.
2. **Places**: candidate spots derived from the city model, such as bench seats, points along
   paths, kiosk counters and playgrounds. New cards create new places.
3. **Occupancy**: each place is occupied when a seeded draw, fixed per place, falls below the
   activity level, adjusted by how comfortable the place is. Raising activity then only adds
   people, and adding a card only affects the places it creates. The scene stays stable while the
   facilitator explores.
4. **Movement**: walkers cross the space on a walkable network built from the city model, choosing
   routes by perceived cost. Unlit stretches cost more at night, and stretches in heat or cold
   cost more in summer or winter.
5. **Comfort curves**: small, monotone functions from field values to behaviour (stay, pass, visit,
   route cost), anchored on recognized thresholds. The social model knows curves, the field knows
   grids, and the two meet through a sampler.
6. **Context**: other users of the space, such as traffic that stops at crossings for pedestrians
   or dogs with their owners, make the scene readable as a real place.

### Closing the loop to indicators

The social model can also produce figures, for example expected people in thermal stress hour by
hour, for the proposal and for "as is". Compute these as **expected values** from the same plan
and curves, not by counting figures on screen. They then stay stable and independent of what the
view happens to show.

*In the reference implementation:* the social model runs in the browser
(`frontend/src/three/people/`). It consists of `activity.ts`, `plan.ts` (seeded spots and
occupancy), `comfort.ts` (UTCI-anchored curves), `network.ts` (footpaths repaired into a
connected graph plus zebra crossings), `walkers.ts` (routes costed by lighting and comfort),
`traffic.ts` (cars with lanes, signals and yielding at crossings) and `daily.ts` (the daily stress
curve). Every choice is seeded from stable ids, so a shared link shows the same crowd. The
`?comfort=off` and `?life=off|still|live` parameters allow comparison and measurement.

The reference implementation first kept the crowd independent of the indicators. Letting the
felt-temperature field drive behaviour was a deliberate later step. It is the step that turns two
parallel models into one.

## 9. Layer 6: indicators

Indicators summarize a scenario for the discussion. Some guidelines:

- **Always pair them with "as is".** The question is what the proposal changes, not the absolute
  value.
- **Cover both sides.** Physical indicators (space use, CO₂, felt temperature, cost) belong next to
  social ones (accessibility, safety at night, which age groups are catered for, people in thermal
  stress).
- **Show them over time.** Many nature-based benefits appear only after years of growth, while
  costs come at once.
- **Label them as proxies.** Each indicator should have a one-sentence definition and a note on
  its limits.
- **Describe them with data.** Each indicator should have a descriptor with its label, unit,
  direction (higher is better or worse) and group, so that a new domain can add indicators without
  frontend changes.

*In the reference implementation:* indicators come from the yearly model (space use, CO₂,
accessibility, social coverage, cost) and from the felt-temperature field (mean felt temperature,
% in heat stress, % in sun). `GET /api/scene` returns them for the proposal and for "as is" at
year `t`, and `GET /api/indicators/series` returns them for every year. The set is still fixed in
`schema.py` and `frontend/src/api/types.ts`; moving to descriptors is a planned step.

## 10. Layer 7: views and interaction

### Several views of one model

Each view answers a different kind of question, and all of them are derived from the same resolved
scenario:

| View | Good for |
| --- | --- |
| **2D map** | Placing cards precisely, seeing the whole site, reading fields as layers |
| **3D view** | "What will it look like from here", shade and light, people using the space |
| **Charts** | Change over time, proposal against "as is" |

An interventions switch (hidden / shown as cards / shown as built) lets the group move between
"what we have", "what we propose" and "what it would become".

### The 3D view

- **Realism with a disclaimer.** A lit, textured, eye-level scene is persuasive. It should carry an
  explicit "indicative view" label.
- **Physically placed light.** Shade is what the indicators argue about, so the sun's position must
  come from the real solar position for the site, date and hour, never from an artistic choice.
- **Viewpoints and walking.** Placing a viewpoint answers "what does it look like from here".
  Walking at eye height answers "what is it like to be here". Keep walking plain, so the view
  stays a discussion tool rather than a game.
- **Seams for better data.** Isolate how buildings are made, through a provider interface, so that
  better geometry such as LiDAR solids or photogrammetry can replace extruded footprints later.
- **A latency budget.** Decide target latencies for changing the date, the year and a card, and
  measure them. Expensive geometry, such as procedural trees, should be built off the main thread,
  cached by content, and not rebuilt when only the date changes.

*In the reference implementation:* the frontend is React, MapLibre with Terra Draw for placement,
and three.js (`frontend/src/`). `App.tsx` owns the state and has three tabs (*Mappa 2D*,
*Vista 3D*, *Indicatori*). `three/SceneBuilder.ts` and `three/builders/` build the scene, with
buildings behind `BuildingGeometryProvider` and trees built in a worker pool
(`three/workers/treeWorkerPool.ts`). Lighting uses real solar position (`three/Lighting.ts`,
`three/sun.ts`), and streetlights are lit cheaply in the shaders (`three/lampLighting.ts`).
`perf/` measures responsiveness against agreed targets (`?perf=1`). URL parameters are listed in
the README.

## 11. Adapting the approach to a new site or domain

The layering is meant to carry over. To adapt the twin, work through the layers in order:

| Layer | For a new site | For a new domain (e.g. a forested valley) |
| --- | --- | --- |
| City model | New site entry and ingestion run; check data gaps | New element types (stands, roads, huts), terrain |
| Interventions | Usually unchanged | New card deck (thinning, replanting, trails) |
| Physical model | Local parameters (species, prices, climate) | New sub-models (disease, windthrow, timber) on the same framework |
| Spatial fields | Local weather and horizon | Fields that fit the domain (risk, accessibility, visual exposure) |
| Social model | Local activity patterns | Different users (hikers, residents, workers) and places |
| Indicators | Same set, local values | New descriptors |
| Views | Same | New builders for terrain and forest at scale |

The aim is a shared core (scenario handling, sessions, views, the fields and social-model
machinery) plus **domain packs**. Each pack provides a model, cards, indicator descriptors,
ingestion, view builders and a social layer.

## 12. Limits and open questions

- **Calibration and validation.** All coefficients and behaviour curves in the reference
  implementation are placeholders. Before real use they need review by domain experts (urban
  climate, forestry, social science), and at least a sanity check against measurements.
- **Uncertainty.** Proposals play out under unknowns, such as climate change and tree diseases. A
  natural next step is named scenarios as *interventions × assumptions*, with comparison between
  them. The framework's parameter overrides and ensembles are the intended mechanism.
- **Richer social fields.** Social safety, noise and accessibility as fields that people react to,
  next to felt temperature.
- **Data quality.** Invented species, sparse covers and inferred markings limit what can be claimed.
  Municipal tree censuses and surveys would raise the ceiling.
- **Participation.** The PoC assumes one facilitator. Multi-user input, remote participation and
  how citizens' own proposals are recorded and compared are open design questions.

## Appendix — Reference implementation map

| Concept | Files |
| --- | --- |
| Site registry | `civic_engagement/config.py` |
| Ingestion | `civic_engagement/ingestion/` |
| Data schema and API contract | `civic_engagement/models/schema.py`, `frontend/src/api/types.ts` |
| Cards | `civic_engagement/api/routes_cards.py` |
| Session store | `civic_engagement/store/state.py` |
| Scenario layout and encoding | `packs/bologna-civic-dt/bologna_civic_dt/layout.py`, `encode.py`, `shapes.py` |
| Physical model (yearly) | `packs/bologna-civic-dt/bologna_civic_dt/model.py`, `geometry.py`, `parameters.py` |
| Felt-temperature field | `packs/bologna-civic-dt/bologna_civic_dt/thermal_field.py`, `field_grid.py`, `solar.py` |
| Framework workarounds | `packs/bologna-civic-dt/bologna_civic_dt/cdt_compat.py` |
| Scene assembly, caching, "as is" pairing | `civic_engagement/scene.py` |
| App shell and state | `frontend/src/App.tsx` |
| 2D map | `frontend/src/map/` |
| 3D view | `frontend/src/three/` |
| Fields in the views | `frontend/src/thermal/field.ts`, `map/thermalLayer.ts`, `three/thermalOverlay.ts` |
| Social model | `frontend/src/three/people/` |
| Panels | `frontend/src/ui/` |
| Performance | `frontend/src/perf/`, `ui/PerfPanel.tsx` |
