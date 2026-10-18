# Demo: Piazza Dante, Utopia — a square that heats up

A storyline in seven steps: over the next ten years the square gets too hot
to use on summer mornings; the interventions (rows of oaks along the paths,
above all) bring it back, and light makes it usable at night; and the twin shows it in 2D, in 3D, as a
felt-temperature map and in the indicators.

The numbers below come from the model with the demo preset loaded; they're
placeholders of a cheap model (see `model.md`, beside this file), good for telling the
story, not for deciding.

## The assumptions behind it

- **Climate**: a summer like 2022 (at the reference station: 24.8 °C on average, the
  second warmest in a century, 65 days above 30 °C) becomes the usual one in
  ten years — about +2 °C in June-August — then +0.5 °C a decade
  (`CLIMATE_WARMING_C` in `packs/bologna-civic-dt/bologna_civic_dt/parameters.py`).
- **People** stay where it's up to 30 °C felt, and leave quickly past 32 °C,
  UTCI's "strong heat stress" (`STAY` in
  `frontend/src/three/people/comfort.ts`).
- **The moment**: 21 June at 11:00. Today the sunny benches of the arc in
  step 2 are about 33.5 °C felt, where some people still sit; in ten years
  about 35 °C, where nobody does. The thermal indicators use the same
  moment.

## Before the demo

1. Start the backend on the preset (the session it replaces is set aside,
   not lost), and the production build (the dev build is much slower):

       CIVIC_TWIN_SCENARIO=demo uv run uvicorn bologna_civic_dt.main:app
       cd frontend && npm run build && npm run preview

   Or, with the backend already running: "Scenarios" → "Demo Piazza Dante"
   → "Load".

2. Open the first link below once, to warm the caches (the first felt-temperature
   map of each year takes a few seconds).

The preset (`data/piazza_dante/scenarios/demo.json`) has:

- **12 rows of oaks** ("Filare di alberi"), 3 m canopy: 11 about 4 m
  beside the main paths on the side the morning sun comes from (the
  longest split in three), and one beside the arc of benches of steps 2
  and 4 — 116 oaks. The rows around the arc and those that shade benches
  are planted now, the others one a year from year 3 to year 8 (they
  change no bench's temperature at +10, 11:00);
- **a lit path** ("Illuminazione lungo un percorso", 15 lamps) across the
  square, in year 1;
- a wooden path and a gravel path (now), a playground (year 2), an oak
  grove (year 12).

The links assume the preview on port 4173 (5173 for the dev server). They
open with the side boxes closed (`panels=closed`); "Temperatura percepita"
starts closed anyway.

The links of steps 1 and 2 open on "Situazione attuale"
(`interventions=attuale`; also `carte`, `simulazione`), the others on
"Simulazione", the default. To fine-tune a 3D viewpoint: move the camera,
then "Copia URL vista" copies a link that reopens it, switch included (add
`&panels=closed`).

## 1. The square, and the problem (Mappa 2D, then Vista 3D)

[Open](http://localhost:4173/?t=0&month=6&day=21&hour=11&panels=closed&interventions=attuale) — 2D,
today, 21 June at 11:00, felt temperature off.

- It opens on **"Situazione attuale"** (the card deck and the list of
  interventions are hidden there).
- Move around the square: the paths, the benches, the trees, the fountains.
  Switch to **"Vista 3D"** and look around ("Vista d'insieme" in the
  mini-map for the overview).
- The problem, in words: summers like 2022 are becoming the usual ones; in
  ten years, a June late morning on these benches is too hot to sit.

## 2. What it means for people (Vista 3D)

[Open](http://localhost:4173/?t=0&month=6&day=21&hour=11&panels=closed&interventions=attuale&lng=11.120438&lat=46.071454&eyeHeight=16&bearing=303&pitch=-25)
— 3D, today at 11:00, looking west-north-west over the arc of benches west
of the central open space.

- It opens on **"Situazione attuale"**.
- Today people sit on the arc (about 4) and around the square (about 30
  sitting, 50 stopping).
- Move the year to **+10a**: the arc empties (0), the square too (about 18
  sitting, 34 stopping). The people who still come crowd the few shaded
  benches.

## 3. The proposals (Mappa 2D)

- Year back to **Ora** — important: a card is planted in the year shown
  when it's placed.
- Interventions on **"Carte proposte"**: the deck and the list come back.
  At "Ora" the map shows what's done now (the rows around the arc and to
  the north, the two paths); the list has every card with its year. Drag
  the year to +8 and back to see the rest come in (the lit path, the
  playground, the other rows) — then back to **Ora** for the live card.
- **Live card**: "Illuminazione lungo un percorso" (Sociale), spacing as
  proposed (15 m). Draw it roughly along the **gravel path** that runs
  north-south just east of the arc of benches, from the wooden path
  northwards — a few clicks from one end to the other; precision doesn't
  matter, every lamp lights 12 m around it. It places about 5 lamps.
- "Indicatori chiave": safety ("Sicurezza") goes up.

## 4. Ten years on, with and without (Vista 3D)

[Open](http://localhost:4173/?t=10&month=6&day=21&hour=11&panels=closed&lng=11.120438&lat=46.071454&eyeHeight=16&bearing=303&pitch=-25)
— 3D, +10a, 11:00, the same view.

- Switch between **"Simulazione"** (with the proposals) and **"Situazione
  attuale"** (without).
- Without: the arc empty, about 18 people sitting on the square. With: about
  7 on the arc and 35 sitting, 56 stopping — more than today.
- The gravel path next to the arc is one of the proposals, so it's missing
  in "Situazione attuale".

## 5. Seeing the heat (Mappa on)

- Tick **"Mappa"** in "Temperatura percepita": the felt temperature drawn
  about 1 m above the ground. The benches of the arc: about 35 °C without
  the rows, about 25 °C with.
- "Nella giornata" now has three lines: today, in ten years without, in ten
  years with the proposals.

## 6. Seasons and times of day

- Untick "Mappa". Date: "Solstizio d'inverno" (bare trees, low sun), mid
  October (autumn colours), back to "Solstizio d'estate".
- Drag **"Ora"** through the day: shade and people move with the sun.
- **Night**: [open](http://localhost:4173/?t=10&month=6&day=21&hour=22.5&panels=closed&lng=11.120438&lat=46.071454&eyeHeight=16&bearing=303&pitch=-25)
  — the view of steps 2 and 4 at 22:30. Switch "Simulazione" / "Situazione
  attuale": the lamps placed live along the gravel path (and, at the bottom
  of the view, the lit path across the square) against the dark square; at
  night people walk the lit paths and stop only where it's lit.

## 7. The indicators (Indicatori)

- **"Temperatura percepita (21 giugno, ore 11)"** over the years: without
  the proposals from 31.8 °C today to 33.5 in ten years and 34.8 in thirty;
  with them 31.7, 32.7, 32.6.
- **"Area in stress da caldo"**: without, 71% → 79% → 82%; with, 70% →
  69% → 61%. The curves step with the plantings of the first years.
- Also: green space, CO₂ absorbed, safety (45 without the proposals, 55
  with them, 57 with the live lamps too, in ten years), cost (about 143 k€
  by year 8, mostly the oaks; it grows as the plantings come in).
- **"Manutenzione aggiuntiva"** (in "Costi"), the upkeep the proposals add:
  from about 5 k€ a year now to 15 k€ once everything is planted, 117 k€
  over the ten years — almost as much again as building them.

## After the demo

The live lamps are now in the session: reload the preset before the next
demo (step 1 of "Before the demo").
