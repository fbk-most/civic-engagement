# TODO — rural pack

Ideas and improvements discussed but not (yet) implemented, grouped by area.
Items marked *waiting* depend on something outside the code (feedback, data).
The core's list is the repository's `TODO.md`: the forest's rendering
(near detail, reuse across year changes...) is there, as the code is the
core's. The plan and the measurements so far are in
`docs/plan-terrain-forest-rendering.md`.

## Forest

- **The trees' look**: from afar the spruce belt hardly shows (dark crowns
  on the dark painted forest floor); every tree is full-height, with no
  smaller trees beneath; crown colours and shapes are placeholders
  (`frontend/src/trees.ts`).
- *Waiting for data* — **Real stand attributes**: species, age and density
  from PAT's forest management plans ("particelle"), tree heights from a
  LiDAR canopy height model (DSM − DTM). Today they're placeholders by
  altitude belt (`rural_digital_twin/stands.py`).

## Cards and model

- **Grove guardrails** (from the terrain branch): planting only on suitable
  covers, at least one tree, a cap.
- **A planting on a stand doubles its trees**: the stub model doesn't clear
  the forest under a planting.

## Data and sites

- **The village's buildings**, from OpenStreetMap.
- **A coarse terrain around the site** (TINITALY or Copernicus DEM), so the
  valley doesn't end at the municipality's edge.

## Feasibility study

See the plan's work items 5 and 6.

- **2D hillshade**, and the cost estimate for real terrain in MapLibre.
- **Measurements**: shadows on and off, first-view time, memory, frame rate
  against the number of trees, against the plan's targets.
- **The 500 km² assessment**: which ways of viewing are viable at which
  scale.
