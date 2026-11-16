# Porting `feat/cultivate_terrain_card`

A guide for whoever (person or agent) rebases this branch onto a more advanced
`civic-engagement` project. Read it before touching code. It is a plan, not a
record of everything: the README sections named below hold the details.

## What the branch contains

Two kinds of work, deliberately kept apart so they can land separately:

1. **General**: applies to any card, not only `cultivate_terrain`.
   Clearing, occupancy, param validation, warning confirmation, refusal errors.
2. **Card-specific**: the `cultivate_terrain` card ("Coltiva il terreno") itself.

The branch was developed on a baseline snapshot; it has 12 earlier commits plus
the work committed with this file. The early commits mix the two kinds, so
rebase by *content*, not by commit.

## Proposed order

1. **Branch A, general**, off the target's main, e.g. `feat/clearing-and-validation`.
2. **Branch B, card**, stacked on A, e.g. `feat/cultivate_terrain_card`.
3. Re-record the reference fixtures **once**, at the end, on B.

Port files with `git checkout <this-branch> -- <paths>`. For files holding both
kinds of change (marked *mixed* below) use `git add -p`. Run the tests after
each branch.

## A. General part

### A1. Clearing analysis (the rule that decides what a card removes)
- `civic_twin/domains/urban/clearing.py`: `analyse` (read-only), `apply_clearing`,
  `CLEARING_CARDS` (the opt-in set; **it holds `"cultivate_terrain"`, which is
  the card hook, so move that one entry to B**).
- Tables in `parameters.py` (clearable, protected and warning element types and
  covers; *mixed*). Plain tables, so a new site adds a line.
- A baseline tree is a `tree` before its `cut_year`, a `stump` from then until
  replanted, and nothing after. Stumps are listed separately.
- The `cleared_by` flag served on cleared baseline objects, with the frontend
  rule in `frontend/src/api/visibility.ts` and the scene changes in
  `civic_twin/scene.py`, `encode.py`, `model.py` and `geometry.py` (*mixed*).
- Tests: `tests/test_clearing.py`, `tests/test_clearing_apply.py`.
- README: "Cards that clear their area".

### A2. Check-before-place and refusals
- `POST /api/interventions/check` answers 200 with errors and warnings;
  create and PATCH answer **409** when something is blocked or a warning is not
  confirmed. Warnings carry a `key`; create takes `acknowledged_warnings`.
  Code: `civic_twin/api/routes_interventions.py`, `civic_twin/models/schema.py`.
- Frontend: `InterventionBlockedError` in `frontend/src/api/client.ts`,
  `frontend/src/ui/CheckReport.tsx`, `ParamForm.tsx`, `App.tsx` (*mixed*).
- Tests: `tests/test_check.py`.
- README: "Errors".

### A3. Occupancy rule
- `civic_twin/domains/urban/occupancy.py` (new file): what already stands on the
  area a card needs. Create and PATCH answer 409 on conflict. Paths may cross
  each other. Saved sessions are not re-checked.
- Footprint tables in `parameters.py` (placeholders; *mixed*).
- Tests: `tests/test_occupancy.py`, `tests/helpers.py`.
- README: "Two things cannot stand on the same ground".

### A4. Param validation
- `validate_params` in `civic_twin/api/routes_cards.py`: 422 with a string
  detail on check, create and PATCH. `SessionStore._load` in
  `civic_twin/store/state.py` skips saved cards with invalid params.
- Frontend: validation in `ParamForm.tsx`, `InvalidParamsError` in `client.ts`.
- Tests: `tests/test_params.py`.
- README: "Adding a card" and "Errors".

## B. Card part

- Card spec and `CardType` entry: `routes_cards.py`, `schema.py`, `frontend/src/api/types.ts`.
- `CULTIVATION_COVER = ("crop_field", "flowerbed", "vegetable_garden")`,
  `DEFAULT_CULTIVATION`, `CULTIVATION_BUFFER_M = 2.0` in `parameters.py`.
  The user picks the cover directly (no separate "purpose" layer).
  A TODO there notes that other cards repeat their defaults as literals.
- Behaviour: `layout.py` and `encode.py` branches for the card, the cover
  prices (placeholders: 5, 30 and 18 EUR/m2), the area with its 2 m margin.
- Frontend: `cardIconShapes.ts`, `cardMarkerIcons.ts`, `labels.ts` (Italian
  labels, "Coltiva il terreno"), margin shown in `CheckReport.tsx`.
- 3D: `frontend/src/three/builders/crops.ts` (new), `materials.ts`, `sun.ts`,
  `SceneBuilder.ts`, `Viewer.tsx`. Plants grow with the season; the covers
  are drawn in plain earth colours.
- Fixtures: `tests/reference/capture.py` (cultivation scenario) and
  `tests/fixtures/reference/*/cultivation*`.

## Watch for when rebasing

- **Conflict-prone files** (the forestry work also edits them): `schema.py`,
  `scene.py`, `App.tsx`, `client.ts`, `types.ts`, `SceneBuilder.ts`,
  `Viewer.tsx`, `View3D.tsx`. Check whether the target already has the forestry
  changes.
- **Crops and terrain:** crops are drawn on a flat ground. If the target has a
  real terrain height, the crop builder must follow it; keep that in one place.
- **Fixtures** store only a SHA-256 of each scene and some summaries. A mismatch
  cannot be diffed. On re-recording, check the indicators and tree lists first
  and say why the hash changed. Do not re-record blindly.
- **Existing cards** are not in `CLEARING_CARDS`, so they behave as before.
  Adding one is a product decision, and it changes the fixtures.
- Not done: the clearing-time indicator (on hold), crop and seed types, seasonal
  visuals beyond growth, terrain tables, real prices and footprints.
- Do not create `docs/actions/` pages; that was postponed.

## Checks to run

- `uv run pytest -q` (keep lines at or under 120 characters).
- Frontend: `npm run build` and `npm run lint`.
- Re-record: `CIVIC_TWIN_SITE=<site> uv run python -m tests.reference.capture`
  for `piazza_dante` and `piazza_xx_settembre`.
