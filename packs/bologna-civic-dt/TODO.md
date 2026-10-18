# TODO — urban pack

Ideas and improvements discussed but not (yet) implemented, grouped by area.
Items marked *waiting* depend on something outside the code (feedback, data).
The core's list is the repository's `TODO.md`.

## Data and sites

- *Waiting for data* — **Bologna orthophoto** (roof colours), once provided.
- *Waiting for data* — **Real Bologna site boundary**, replacing the
  provisional circle.
- **Crossings in the walkability indicator**: zebra crossings don't count
  towards accessibility yet.

## 3D life: people and dogs

The code is still in the core (`frontend/src/three/people/`), used only by
this pack: see the core's TODO, "Package split".

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
- **The pond's reflection** costs about a third of Piazza Dante's frame
  (~9 M triangles and ~180 draw calls, by day and by night: three's
  `Water.js` draws the whole scene again, mirrored). A lower resolution,
  leaving out the far buildings and trees, or updating it less often would
  help.
