# Terrain and valley-scale forest: rendering feasibility study

## Context

The demonstrator (cards on a map, 2D/3D views, indicators over time) runs
on two urban squares, Piazza Dante in Utopia and Piazza XX Settembre in
Bologna. The next goal is to port it to a mountain valley and a forestry
domain: forest diseases, fallen trees, timber production, tourism,
socio-economic aspects. The card concept and the 2D/3D/KPI design stay the
same.

Most of the port is about the domain: new cards, new indicators, a new
model (the models run in the
[civic-digital-twins](https://github.com/fbk-most/civic-digital-twins)
framework; see `packs/bologna-civic-dt/bologna_civic_dt/` for the urban
one). That work is separate from this study, which is about the one
question that could make the forest demo unworkable, whatever the model
looks like:

> Can the current app show a valley-scale forest on real terrain,
> interactively, on the target laptop?

The target laptop has an AMD Radeon 860M (integrated GPU). For reference,
the urban scene with its full crowd runs at 8–10 fps in the overview and at
12 fps or more from a placed viewpoint.

At the end of the study, a first feasibility assessment is also due for the
whole 500 km² territory (Central and Outer Giudicarie): which ways of
viewing are viable at which scale (for example top-down only for very large
extents, full 2D + 3D for smaller ones).

This document merges the plan of the first prototype branch
(`feat/terrain-forest-rendering-foundation`) with the decisions taken when
terrain was brought into the core/domain split (branch `feat/core-split`).

## What is different from the urban sites

| | Urban square | Valley |
|---|---|---|
| Area | ~1–4 ha | several km² in view (Bocenago: 8.45 km²); up to 500 km² for the territorial assessment |
| Ground | flat, or nearly (Piazza Dante has a terrain grid) | terrain with hundreds of metres of relief (Bocenago: 664–2058 m) |
| Trees | ~160–300, each one generated individually | 10⁵–10⁶, described by stands (Bocenago: ~233,000) |
| Camera | orbit over a square, walk at eye level | valley overview, walk on slopes, views across the valley |

## Where we are (18 October 2026)

Paused here for the package split (the core and the two packs moving to
separate repositories); the rest resumes after it.

- **Core/domain split** done: the core (`civic_engagement/`, `frontend/`)
  and two domain packs, urban (`packs/bologna-civic-dt/`) and rural
  (`packs/rural-digital-twin/`). Each pack is an app built on the core.
- **Terrain in the core** (work item 2) and **camera on terrain** (work
  item 4): done.
- **Rural pack**: the Bocenago site, its terrain, land covers and stands,
  two cards (planting, felling), a stub model.
- **Forest** (work item 3): every tree of the stands drawn (~233,000), in
  192 m tiles with culling, shadows near the camera, a reversed depth
  buffer: 60 fps in the overview and in the close-ups. Near detail (the
  procedural trees) is still to do.
- **Still to do**, after the split: near detail and the rest of work item 3,
  the 2D hillshade (work item 5), the measurements and the 500 km²
  assessment (work item 6). The lists are the rural pack's `TODO.md` and,
  for the forest's rendering (core code), the core's.

## Decisions

### Data contract

Site assets plus scene (the first branch's "Design B"):

- Heavy, mostly static geodata is listed by `/api/site-assets` (with a
  content version) and served by `/api/site-assets/{key}?v=`, cached
  immutably. Today: the terrain grid.
- `/api/scene` keeps the dynamic state: year, interventions, indicators,
  elements and covers.
- **Stands are covers with properties** (`CoverPolygon.properties`: species
  mix, density, age...), rather than a separate stand object as in the
  first branch: the model works on them as on any cover, and felling or
  planting changes them like any other.

### Time controls

The three time controls are kept apart:

1. **Hour**: light and material uniforms only, no rebuild.
2. **Day and month**: sun path and phenology (leaf density, autumn colour),
   no rebuild.
3. **Year**: the model's state and the interventions; the trees reuse what
   didn't change (see "Trees").

### Terrain

- A **height grid** built from the DTM (`civic_engagement/ingestion/terrain.py`),
  with its own anchor: uint16 heights above the site's lowest point,
  every 2 m (Piazza Dante) or 5 m (Bocenago). Gaps in the DTM are filled
  smoothly.
- `heightAt(x, z)` is exactly the grid's triangles, so that whatever lies on
  the ground (draped covers, paths) lies exactly on what is drawn.
- **Optional, per site**: a site without a grid is flat, and the core's code
  path is then the one before terrain (verified by comparing scene graphs).
  `?terrain=off` draws a site flat.
- Piazza Dante keeps its terrain grid.

### Covers on terrain

- **Painted onto the terrain** (one texture, 2 m per pixel) on sites where
  the pack asks for it (`scene3d.paintCovers`, on for rural): a valley's
  forest and meadows are large, and laid as meshes they doubled the
  triangles (~1.4 M on Bocenago).
- **Draped as meshes** otherwise (the urban squares: sharp edges for
  paving).

### Trees

- **Spatial tiles** (192 m) on the outside; inside each tile, the batches by
  how trees change (grown, growing, changed this time), reused across
  scenes as on the urban sites.
- **Seasons without a rebuild** at every detail level (the cheap ones by
  colour and uniforms).
- **Full detail built on demand** around the camera, within a budget, in
  the worker pool, with cancellation; this replaces the first branch's
  all-or-nothing cap of 400 detailed trees.
- **Per-tile culling**.
- **A tree source per tile**, supplied by the pack: the rural pack grows the
  trees from the stands (`scene3d.treeSource`).
- **Switchable per site or domain**: tiles and detail levels are off for
  Piazza Dante (except for tests), and "off" means exactly today's code
  path.
- **Every tree drawn, at every distance.** Thinning the far tiles to a
  tenth, with wider crowns, was tried and showed too much (in the overview,
  and on the slopes across the valley); it stays as a test switch
  (`?treeFar=N`).
- **Shadows** only from the tiles within 1200 m of the camera
  (`?treeShadows=N|off`).
- **A reversed depth buffer**, a pack's choice (`scene3d.reversedDepth`, on
  for rural): the logarithmic one turns off the GPU's early depth test, so
  every hidden crown was shaded; reversed, with a float depth buffer, the
  close-ups went from 45 to 60 fps. Not for urban yet: three's `Water.js`
  reflection assumes the usual depth.
- **Tree positions** come from one fixed pattern over the site (a jittered
  lattice, seeded per point), kept where a stand is and by the stand's
  density: they don't depend on a stand's shape, so a felling removes the
  trees in its area and moves no other.

### 2D terrain

Option (a), hillshade only, to implement; option (b), real terrain in
MapLibre, to estimate.

### Measurement method

- The in-app readout (`?perf=1`): fps, frame times, draw calls, triangles,
  CPU render time.
- Plus first-view timing and JS memory (where available) and a GPU memory
  proxy: still to add.
- Rural has no 3D life; urban benchmarks use `life=off`.

### Performance targets

- First view in **under 15 s** (hard target).
- Overview: 15 fps or more; acceptable floor 10–12 fps.
- Eye level: 20 fps or more; acceptable floor 15 fps.

## Site and inputs

- **Pilot site: the municipality of Bocenago** (Rendena valley), its
  boundary from OpenStreetMap (relation 46873), 8.45 km². (The first
  branch's 2×3 km window sat about 1 km west of the municipality.)
- **DTM**: PAT LiDAR, 0.5 m, ESRI ASCII; seven downloads combined into
  `data/bocenago/lidar/dtm.asc.gz` (not in the repository; see `SOURCE.txt`
  there). It covers the whole municipality, and 99.5% of it with a 150 m
  margin. The terrain grid built from it, every 5 m, is in the repository.
- **Land covers**: OpenStreetMap, all of them (forest, meadow, grassland,
  scrub, rock, residential), without overlaps.
- **Stands**: the forest cut by altitude belts (beech up to 1000 m, spruce up
  to 1600 m, larch above), each with a placeholder species mix and density
  (beech 300, spruce 400, larch 250 trees per hectare), mature. Seven
  stands, 678 ha.
- **Later, optional**: PAT forest management plans (compartments with
  species and age); a LiDAR DSM for canopy height (DSM − DTM); a coarse
  DEM backdrop around the site (TINITALY or Copernicus); the village's
  buildings from OpenStreetMap.

## Architecture: binding choices and tuning knobs

### Binding

1. Terrain and vegetation in tiles: no single forest object.
2. Work split by clock: camera, hour, day and month, year.
3. Detail levels: near, the procedural trees (`treeStructure.ts`,
   `foliageCards.ts`, worker pool); beyond, instanced low-poly trees. (A
   far level with fewer trees was tried and rejected, see "Trees".)

### Tuning knobs, with their values so far

- tile size: **192 m**;
- shadows: tiles within **1200 m** cast, farther ones only receive;
- hysteresis: **15%** around the thresholds;
- still to set, with near detail: its distance (first guess 90 m) and the
  build budget (first guess at most 1 heavy tile update per frame, 2 when
  idle).

## Work items

### 1. Site assets — done

`/api/site-assets` and `/api/site-assets/{key}?v=` (`civic_engagement/site_assets.py`).

### 2. Terrain in 3D — done

- The terrain surface in 64-cell tiles (`builders/terrainSurface.ts`); no
  terrain detail levels so far, and none needed at Bocenago's size.
- Everything that stands on the ground follows it: covers and paths
  (draped), buildings (at the lowest ground under their outline), water (at
  the highest shore), trees, the urban pack's furniture and streetlights,
  placards, people, dogs, traffic, the felt-temperature sheet.
- Known limits: ponds on slopes float; covers draped as meshes on a site
  with terrain cost as many triangles as the terrain under them.

### 3. Forest at valley scale — mostly done

- Done: the generator (`packs/rural-digital-twin/frontend/src/trees.ts`)
  and the core renderer (`frontend/src/three/builders/forest.ts`): a trunk
  and a crown per tree, instanced, in 192 m tiles with culling, seasons by
  colour, shadows within 1200 m. Every tree is drawn (`?treeShare=` draws a
  share, for testing).
- To do (the core's `TODO.md`, "Forest rendering"): near detail; reusing
  the tiles that didn't change across year and card changes (every change
  rebuilds the whole forest, ~2 s); counts in the performance readout.
- Also (the rural pack's `TODO.md`): the trees' look; the grove guardrails
  of the first branch.

### 4. Camera and navigation on terrain — done

- The orbit target, the minimum camera height and walk mode follow the
  terrain.
- Zoom-out and panning are limited to keep the site in view; the far plane
  follows.
- The 2D ↔ 3D sync takes the ground point on the terrain.

### 5. Terrain in the 2D map — to do

- Implement (a): a hillshade, pre-rendered, served like the orthophoto; the
  2D map stays flat and top-down.
- Estimate (b), MapLibre DEM: data pipeline, sync implications, effort.

### 6. Measurements and the 500 km² assessment — references so far

On the Radeon 860M:

- fps in the overview, at mid distance and at eye level;
- with shadows on and off;
- first-view time;
- JS memory and a GPU memory proxy;
- fps against the number of trees (10⁴, 10⁵, 10⁶).

To do first: make the "Measure" benchmark fit rural (it uses fixed hours,
and rows for people and traffic, which rural doesn't have). The temporary
3-view benchmark used for the references below has been removed; its views
can be opened by URL (see below).

The 500 km² assessment must say:

- whether full interactive 2D + 3D is feasible at territorial scale;
- if not, which modes are viable (for example top-down only at full
  extent, full 2D + 3D in selected areas);
- the thresholds for switching mode (extent, tree count, tile budget);
- what this means for the users' workflow.

## Performance references

Bocenago, Radeon 860M, 1920 × 1081, Chrome, preview build. The frame rate
is capped at 60 by vsync, so 60 fps means "at least 60". Draw calls and
triangles include the shadow pass.

The views, at eye level (1.65 m, field of view 60°):

- overview: the whole site;
- valley floor, looking east (lng 10.759621, lat 46.118331, bearing 90,
  pitch 5);
- mid-slope, looking west (lng 10.775029, lat 46.118542, bearing 270,
  pitch −5).

For instance:
`?perf=1&month=6&day=21&hour=11&lng=10.759621&lat=46.118331&eyeHeight=1.65&bearing=90&pitch=5&fov=60`.

| Moment | Overview | Valley floor | Mid-slope |
|---|---|---|---|
| Bare terrain (rotating camera, 18:00) | 60 fps · 339 calls · 2.55 M tris | 60 · 181–232 · 1.36–1.76 M | 60 · 175–218 · 1.39–1.70 M |
| Covers as meshes (still camera, 21/6 11:00, as below) | 60 · 428 · 3.89 M | 60 · 309 · 3.22 M | 60 · 276 · 3.01 M |
| Covers painted | 60 · 334 · 2.45 M | 60 · 261 · 1.89 M | 60 · 228 · 1.72 M |
| Trees, a tenth (~34,000) | 60 · 342 · 4.02 M | 60 · 269 · 3.46 M | 60 · 236 · 3.29 M |
| Trees, all (~340,000) | 49 (p95 33 ms) · 342 · 18.2 M | 28.5 (p95 50 ms) · 269 · 17.6 M | 30 (p95 33 ms) · 236 · 17.5 M |

CPU render time stays at 0.6–1.6 ms in these: the limit is the GPU. With
all the trees, every view draws nearly the same triangles, because nothing
is culled; the close-ups are the slowest.

Then with tiles and culling (CPU render time 2–10 ms: the tiles' draw
calls):

| Moment | Overview | Valley floor | Mid-slope |
|---|---|---|---|
| ~340,000 trees, a tenth beyond 350 m, shadows within 350 m | 60 · 1021 · 2.97 M | 60 · 719 · 2.56 M | 53 (p95 33 ms) · 538 · 2.75 M |
| ~340,000 trees, a tenth beyond 800 m | 60 · 1011 · 2.81 M | 59.5 · 856 · 3.24 M | 60 · 724 · 4.36 M |
| ~340,000 trees, all, shadows from every tile | 60 · 2232 · 13.3 M | 38 (p95 33 ms) · 1803 · 11.2 M | 42 (p95 33 ms) · 1523 · 8.9 M |
| ~233,000 trees (new densities), shadows within 250 m | 60 · 1283 · 7.85 M | 45 (p95 33 ms) · 878 · 5.88 M | 51 (p95 33 ms) · 610 · 3.78 M |
| the same, shadows within 1200 m | 60 · 1283 · 7.85 M | 46 (p95 33 ms) · 1144 · 7.27 M | 46 (p95 34 ms) · 1032 · 6.66 M |
| the same, reversed depth buffer (today's default) | 60 · 1283 · 7.85 M | 60 · 1144 · 7.27 M | 60 · 1032 · 6.66 M |

The shadows barely matter; what did was shading the crowns hidden behind
the nearest ones, which the logarithmic depth buffer forced (see "Trees").

## Deliverables

1. The prototype, in the core and the rural pack (on `feat/core-split`, then
   `main`; later in separate repositories).
2. A short report:
   - the measurements of work item 6, with screenshots;
   - the recommended detail-level and culling settings;
   - the hillshade, and the cost estimate for the MapLibre DEM;
   - the first 500 km² assessment, with the recommended ways of viewing by
     scale.
3. Go / no-go statements:
   - valley-scale forest rendering on the pilot site;
   - the territorial (500 km²) strategy, and its constraints.

## Open decisions

- Access to the PAT forest management plans for Bocenago.
- Final tuning values, after the first measurements with tiles and detail
  levels.
- Whether real stand attributes (plans, canopy height) are needed before the
  report, or the placeholders are enough.
