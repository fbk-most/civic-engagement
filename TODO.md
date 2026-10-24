# TODO

Ideas and improvements discussed but not (yet) implemented, grouped by area.
Items marked *waiting* depend on something outside the code (feedback, data).

This is the core's list. Each domain pack keeps its own, in its repository
(`bologna-civic-dt`, `rural-digital-twin`).

## After the package split

- **Releases**: once the core settles, versioned releases (tags, or a
  registry) rather than commit pins.
- **Features urban-in-core**: the felt-temperature field and the 3D life
  (people, dogs, traffic) live in the core's code, with their 3D assets,
  but only the urban pack uses them (`FrontendPack.features`); decide
  whether they move to the pack (which would need a way for a pack to bring
  3D life into the core's viewer).
- **The map's opening centre** (`frontend/src/map/mapSetup.ts`) is Piazza
  Dante's: take it from the site.

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

## 3D view

- **The boundary through the trees but not the hills**: today the site's
  boundary line (`three/builders/boundary.ts`) is hidden by whatever is in
  front of it; drawn through everything it showed stretches behind ridges,
  and a faint copy where hidden didn't tell trees from hills at eye level.
  To be hidden by the terrain only: a terrain-only depth pass each frame
  (one more terrain draw) tested in the line's shader (both depth buffers,
  reversed and logarithmic), or rays against the terrain on the CPU when
  the camera moves (some ms, and lagging while flying).
- **Cascaded shadow maps**: one shadow map over a scene of some km (the
  rural pack's, 500 m past the boundary) is coarse up close; split it by
  distance from the camera.
- **Whole windows**: the facade is a tiled texture (see `three/facade.ts`),
  one window per bay and storey from the building's lowest ground, so on a
  slope the windows start underground, and the eaves and the gables cut
  them anywhere. Windows fitted to each wall: whole storeys above the
  ground, none cut by the roof, maybe a door.

## Terrain

- **Bumpy streets and pavements on a city's terrain**: with Piazza Dante's
  terrain on, roads and sidewalks follow small height changes of the DTM,
  probably measurement artefacts or noise rather than real relief, and
  look bumpy; the urban demo runs flat (`?terrain=off`) for this reason.
  The grid builder now averages the DTM over each cell (no more aliasing)
  and shapes the ground under lines (`TerrainLine`: the rural pack's roads
  and streams, the urban pack's streets and paths, which looked fine);
  still to do: shape it under the paved areas too (polygons, not lines
  yet), check that a smoothed square still drains the way the real one 
  does, and let the urban demo open with its terrain.

## Forest rendering

The forest the rural pack grows (`frontend/src/three/builders/forest.ts`;
see `docs/plan-terrain-forest-rendering.md` in `rural-digital-twin`).

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
