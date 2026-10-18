# TODO

Ideas and improvements discussed but not (yet) implemented, grouped by area.
Items marked *waiting* depend on something outside the code (feedback, data).

This is the core's list. Each domain pack keeps its own:
`packs/bologna-civic-dt/TODO.md` (urban) and `packs/rural-digital-twin/TODO.md`
(rural).

## Package split (next)

The core and the two packs move to separate repositories (see the README).
Still to decide or do:

- **Data and tests** move into the packs (`data/<site>/`, `tests/`).
- **The 3D assets** (`frontend/public/`): which are the core's and which a
  pack's.
- **How the core is distributed** to the packs (Python package, npm
  package).
- **Environment variables**: possibly renamed (`CIVIC_TWIN_SITE`...).
- **The README**: one per repository.
- **The packs' docs** refer to files by their path in this repository
  (`packs/bologna-civic-dt/docs/model.md` above all): update them.
- **Features urban-in-core**: the felt-temperature field and the 3D life
  (people, dogs, traffic) live in the core's code but only the urban pack
  uses them (`FrontendPack.features`); decide where they go.

## Interface

- *Waiting for end-user feedback* — **3D mini-map content**: simplify what the
  small map in the 3D view shows (it's crowded). "Ingrandisci" is the stop-gap.
- *Waiting for end-user feedback* — **Indicator charts**: richer interaction
  (hover read-outs, zoom, comparing scenarios), possibly with a charting
  library once the requirements are clear.
- **README**: the "Realistic 3D view" section predates the tabbed interface
  (e.g. the viewpoint is now placed from the 3D view's mini-map, not the 2D
  map) and doesn't cover people and traffic; refresh it.
- **Initial framing that shows the whole site**: the opening zoom of the 2D
  map, the 3D view and the 3D mini-map should fit the whole site, whatever
  its size and shape. Today the 2D map and the mini-map fit the site
  boundary with a fixed padding, without allowing for the side panels
  covering the map; the 3D overview ("Torna alla vista d'insieme") uses a
  fixed angle and distance.

## Forest rendering

The forest the rural pack grows (`frontend/src/three/builders/forest.ts`;
see `packs/rural-digital-twin/docs/plan-terrain-forest-rendering.md`).

- **Near detail**: the procedural trees (as the urban ones) within about
  90 m of the camera, built on demand in the worker pool within a budget,
  with cancellation; needs a much lighter tree than today's (a mature
  spruce is ~150,000 vertices).
- **Year and card changes**: every scene change regenerates and rebuilds the
  whole forest (~2 s for 233,000 trees); reuse the tiles whose covers
  didn't change, as the scene's own trees reuse their batches.
- **Counts in the performance readout**: trees drawn, tiles in view, tiles
  casting shadows, near trees built.
- **Fewer draw calls**, if they become the limit: one crown mesh per crown
  shape in a tile (the kinds' colours in the shader); far tiles in blocks.
- **Element trees on tiles**: the scene's own trees (`vegetation.ts`) in the
  same tiles, switchable per site (off for Piazza Dante).

## Performance

- *Waiting for a measurement* — **"Measure" on the Nvidia machine**, to know
  whether performance matters only on laptops.
- **"Measure" for sites without 3D life**: one row per moment instead of the
  people and traffic rows, and the URL's hour rather than fixed ones; plus
  first-view time and memory.
- **Reversed depth buffer for every site** (`scene3d.reversedDepth`, on for
  rural): it keeps the GPU's early depth test (45 → 60 fps in Bocenago's
  close-ups), but three's `Water.js` reflection assumes the usual depth
  (the urban pond shows white, its bridge disappears). Needs a reflection
  of our own.
- **`?lights=all` switch**: remove once the simplified lamp lighting has been
  confirmed in workshops.
- **Server-side rendering** (streaming video to the browser): only if workshop
  laptops turn out too weak.
