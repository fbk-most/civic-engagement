# TODO

Ideas and improvements discussed but not (yet) implemented, grouped by area.
Items marked *waiting* depend on something outside the code (feedback, data).

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

## Data and sites

- *Waiting for data* — **Bologna orthophoto** (roof colours), once provided.
- *Waiting for data* — **Real Bologna site boundary**, replacing the
  provisional circle.
- **Crossings in the walkability indicator**: zebra crossings don't count
  towards accessibility yet.

## Cards

- **Streetlights one at a time**: "add_streetlight" places a single lamp, so
  lighting a path takes many cards and the scenario fills up with individual
  streetlights. Either group them (one card for several lamps), or let a
  card place streetlights along a drawn path at a given spacing (cost and
  the safety indicator then count every lamp it creates).

## 3D life: people and dogs

- **Cheaper figures**: the crowd now peaks at 500 people (half standing or
  sitting, half walking) and 90 cars, and holds above 20 fps by day on the
  Radeon laptop. If weaker machines struggle: GPU-instanced crowds with
  animation baked into textures, simplified or flat figures and no shadows
  beyond ~40 m.
- **Path groups look repetitive**: with a spot every 6 m along the paths,
  groups of 2-3 can line up; vary the spacing or cluster them near benches,
  corners and shade.
- **People standing alone where it makes sense**: at a crossing, next to a
  kiosk, a parent near a playground, beside a full bench (single standers
  along paths were removed as they looked purposeless).
- **Missing figures**: children (a scaled adult looks wrong), wheelchair users,
  walking aids; a second dog breed (Quaternius Shiba Inu — the download was
  blocked by a Google Drive quota).
- **Sitting poses**: variety (legs crossed, leaning forward, arm on the
  backrest); hands currently rest palms up.
- **More movement**: occasional gestures ("Wave"/"Interact" clips), switching
  between idles, posture changes.
- **Walkers**: avoiding each other (step aside, slow down) instead of only
  keeping right; sitting down on a free bench and leaving again.
- **Reproducible walkers**: a shared link in "Fermi" reproduces the scene, but
  in "In movimento" walker positions depend on how long the view has been open.
- *Long term* — **Indicator-driven crowds**: attendance derived from the
  indicators rather than from time of day and season only.

## 3D life: traffic

- **Junctions**: cars don't negotiate with each other, so cars on crossing
  streets can briefly pass through each other.
- **Traffic-light orientation**: phases are assigned by compass axis
  (north-south vs east-west) because signal housings aren't rotated; at
  diagonal junctions both roads can get green together. Needs each signal
  rotated to the streets meeting there.
- **Pedestrianised streets**: no cars on them — needs a card to pedestrianise
  a street first.
- **Details**: spinning wheels; brighter headlights and car bodies at night.

## Performance

- **Trees by day**: the scene is GPU-bound mainly on vegetation (~23 M
  triangles per frame, sun shadow pass included). Simpler distant trees and
  fewer trees in the sun's shadow would help.
- *Waiting for a measurement* — **"Misura" on the Nvidia machine**, to know
  whether performance matters only on laptops.
- **`?lights=all` switch**: remove once the simplified lamp lighting has been
  confirmed in workshops.
- **Server-side rendering** (streaming video to the browser): only if workshop
  laptops turn out too weak.
