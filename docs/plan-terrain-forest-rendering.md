# Terrain and valley-scale forest: rendering feasibility study

## Context

The demonstrator (cards on a map, 2D/3D views, indicators over time) runs
today on two urban squares, Piazza Dante in Utopia and Piazza XX Settembre
in Bologna. The next goal is to port it to a mountain valley and a forestry
domain: forest diseases, fallen trees, timber production, tourism,
socio-economic aspects. The card concept and the 2D/3D/KPI design stay the
same.

Most of the port is about the domain: new cards, new indicators, a new
model (the models run in the
[civic-digital-twins](https://github.com/fbk-most/civic-digital-twins)
framework; see `packs/bologna-civic-dt/bologna_civic_dt/` for the urban one). That work
is separate from this study, which is about the one question that could
make the forest demo unworkable, whatever the model looks like:

> Can the current app show a valley-scale forest on real terrain,
> interactively, on the target laptop?

The target laptop has an AMD Radeon 860M (integrated GPU). For reference,
the urban scene with its full crowd runs at 8–10 fps in the overview and at
12 fps or more from a placed viewpoint.

## What is different from the urban sites

| | Urban square (today) | Valley (target) |
|---|---|---|
| Area | ~1–4 ha | several km² (to be fixed with the pilot choice) |
| Ground | flat: everything sits at y = 0 | terrain with hundreds of metres of relief |
| Trees | ~160, each one individually generated | 10⁵–10⁶; must be described per stand |
| Camera | orbit over a square, walk at eye level | overview of a valley, walk on slopes, look across the valley |

## Scope

**In scope**

1. Terrain in 3D, from a DTM.
2. Forest rendering at valley scale, with levels of detail.
3. Camera, navigation and 2D/3D camera sync working on terrain.
4. Terrain readability in the 2D map (hillshade at least).
5. Performance measurements on the Radeon 860M.

**Out of scope**

- forest model, indicators, forestry cards (being worked on separately);
- 3D life (hikers, trucks), seasons, snow;
- polishing: the prototype may use placeholder materials and a hard-coded
  site.

## Inputs

- **Pilot valley** — *to be decided*. An area of about 2×3 km is suggested
  for the study: large enough to stress rendering, small enough to handle
  data by hand.
- **DTM**
  - Source: the Province of Trento (PAT) LiDAR, the same survey and ESRI
    ASCII format already read by `civic_engagement/ingestion/raster.py` and
    `lidar.py`.
  - Resolution: 1 m natively; probably resampled to 2–5 m for the mesh.
- **Canopy height** — DSM − DTM (canopy height model). It gives tree
  heights and, roughly, density; optional for the study.
- **OpenStreetMap**
  - `landuse=forest` / `natural=wood`, with `leaf_type`, for the stands;
  - `highway=track` / `path` for forest roads and trails;
  - buildings (huts, villages).
- **Forest management plans (PAT)** — forest compartments with species and
  age. Availability is to be checked. Not needed for the study: OSM
  polygons with synthetic attributes are enough.

## Work items

### 1. Terrain in 3D

- Build a terrain mesh from the DTM.
  - Split it into chunks with a distance-based level of detail if a single
    mesh is too heavy.
  - Relief is measured relative to the lowest point of the site, so y
    values stay small.
- Add a single height service, `heightAt(x, z)`, used by everything that
  places something on the ground.
- Drape ground covers, paths and roads on the terrain:
  - either as geometry that follows the mesh;
  - or painted into a texture on the terrain.

  Choosing between the two is part of the study: texture painting is
  probably the only option at valley scale.
- **Terrain must stay optional.** A site without a DTM is flat, as today,
  and Piazza Dante and Bologna must look exactly the same.

Known flat-ground assumptions in the current code (not exhaustive):

- `frontend/src/three/shapes.ts` — covers are flat meshes, with a small
  y-lift to settle overlaps.
- `builders/vegetation.ts`, `streetlights.ts`, `furniture.ts`, `paths.ts`,
  `placards.ts` — every element is placed at y = 0.
- `three/walk.ts` — the eye is at a fixed `EYE_HEIGHT_M` above y = 0.
- `three/Viewer.tsx`:
  - the orbit target is clamped to y ≥ 0;
  - panning follows the ground plane;
  - `maxPolarAngle` keeps the camera from orbiting under the ground.
- `three/camera.ts` — `MIN_CAMERA_HEIGHT_M` is measured above y = 0.
- `map/viewSync.ts` — the ground point at the centre of the view is taken
  on the plane y = 0.
- `three/people/*` (crowd, walkers, traffic, dogs) — everyone moves on
  y = 0. This is out of scope for the study, but must be listed in the
  report.

### 2. Forest at valley scale

- Tree positions: generated per stand from a density and a seed (as
  `plant_grove` does today with jittered points), optionally checked
  against the canopy height model.
- Levels of detail, to be designed and measured:
  - **near** (tens of metres): the existing procedural trees
    (`treeStructure.ts`, `foliageCards.ts`, worker pool);
  - **middle** (up to a few hundred metres): instanced low-poly trees, a
    few variants per species;
  - **far**: billboards/impostors, or the canopy painted on the terrain
    texture with some relief.
- The current generator has no levels of detail at all (every tree is
  fully built), so this item is new work, not tuning.
- Shadows, fog and far-plane settings, which matter much more at km scale.

### 3. Camera and navigation on terrain

- The orbit target and the minimum camera height follow the terrain, not
  y = 0.
- Walk mode follows the terrain height.
- Overview framing fits the whole valley. This is related to the TODO item
  "Initial framing that shows the whole site".
- 2D ↔ 3D camera sync (`map/viewSync.ts`): the ground point at the centre
  of the view must be taken on the terrain. Whether the 2D map is flat or
  has terrain (item 4) changes how the two framings correspond.

### 4. Terrain in the 2D map

Two options:

- **(a) Hillshade only** — a pre-rendered image, served like the
  orthophoto (`ingestion/ortofoto.py`). This is the simplest option, and the
  2D map stays a flat top-down view.
- **(b) Real terrain in MapLibre** (`raster-dem` source) — this needs a
  local tile-generation step, and changes the 2D ↔ 3D sync (item 3).

Suggestion for the study: implement (a), and estimate the cost of (b).

### 5. Measurements

On the Radeon 860M, with the frame-rate readout already in the app
(`PerfPanel`):

- fps in the overview of the whole valley, at mid distance, and at eye
  level inside the forest;
- each with shadows on and off;
- load time (baseline fetch plus scene build) and GPU/JS memory;
- how fps changes with the number of trees (for example 10⁴, 10⁵, 10⁶).

Proposed targets, to be confirmed:

- 15 fps or more in the overview;
- 20 fps or more at eye level;
- first view in under 15 s.

## Deliverables

1. A branch off `main` with the prototype.
   - Frontend changes plus an ingestion script.
   - No changes to the model or the indicators (the domain packs, `packs/`):
     the study is about rendering only, and keeping out of the model
     keeps the branch easy to merge.
2. A short report:
   - the numbers from item 5, with screenshots;
   - the recommended levels of detail;
   - the recommended 2D option.
3. A list of the changes needed to merge terrain properly into `main`:
   - the `heightAt` API;
   - which builders use it;
   - how a flat site is handled.
4. A go / no-go on valley-scale forest rendering. If no-go, what would make
   it viable: a smaller area, a coarser forest, or a stronger target
   machine.

## Open decisions

- Pilot valley and area size.
- 2D map: hillshade only, or real terrain.
- Performance targets (above).
- Access to the PAT forest management plans for the pilot area.
