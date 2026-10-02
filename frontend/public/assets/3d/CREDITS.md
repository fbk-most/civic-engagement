# Third-party assets

All assets in this folder are CC0 (public domain) and are vendored into the
repository deliberately, so the tool has no runtime dependency on an internet
connection during a workshop.

## foliage-atlas.png

Derived from **Leaf Set 005** by [ambientCG](https://ambientcg.com/view?id=LeafSet005),
licensed CC0 1.0.

Not the original download: `scripts/build_foliage_atlas.py` selects the four
densest 256x256 tiles from the source colour/opacity maps, merges them into one
RGBA sheet, and bleeds leaf colour into the transparent texels so the mip chain
stays foliage-coloured instead of fringing. Re-generate with:

```bash
uv run --with pillow --with numpy python scripts/build_foliage_atlas.py <LeafSet005_1K-PNG folder>
```

## ground/*.jpg

Tiling ground and path surfaces, all from [ambientCG](https://ambientcg.com),
licensed CC0 1.0:

| File | Source asset |
| --- | --- |
| `paving.jpg` | PavingStones151 |
| `sett.jpg` | PavingStones128 |
| `lawn.jpg` | Grass005 |
| `asphalt.jpg` | Asphalt033 |
| `gravel.jpg` | Gravel043 |

Colour maps only, downscaled to 512 px and re-encoded as JPEG — the full 1K
downloads are ~10 MB each across five map types. Re-generate (needs network)
with:

```bash
uv run --with pillow --with requests python scripts/build_ground_textures.py
```

Real-world tile sizes are declared in `frontend/src/three/assets.ts`; the
renderer scales them by setting `repeat` to 1/tile-size, because every surface
in the scene carries UVs measured in metres.

## people/*.glb

Characters from **Ultimate Modular Men** and **Ultimate Modular Women** by
[Quaternius](https://quaternius.com/packs/ultimatemodularcharacters.html),
licensed CC0 1.0 (the "Individual Characters" glTF downloads).

| File | Source character |
| --- | --- |
| `m-casual2.glb` | Men / Casual_2 |
| `m-hoodie.glb` | Men / Casual_Hoodie |
| `m-suit.glb` | Men / Suit (pistol removed) |
| `m-beach.glb` | Men / Beach |
| `w-casual.glb` | Women / Casual |
| `w-formal.glb` | Women / Formal |
| `w-suit.glb` | Women / Suit |
| `w-adventurer.glb` | Women / Adventurer |

## animals/husky.glb

**Husky** from **Ultimate Animated Animals** by
[Quaternius](https://quaternius.com/packs/ultimateanimatedanimals.html),
licensed CC0 1.0 (downloaded as `Husky` from
[poly.pizza](https://poly.pizza/m/wcWiuEqwzq), saved as `husky.glb`).

## vehicles/*.glb

Cars from [Quaternius](https://quaternius.com/packs/cars.html), licensed CC0
1.0, downloaded from poly.pizza:

| File | Source model |
| --- | --- |
| `car-a.glb` | [Car](https://poly.pizza/m/Cz6yDaUcM9) |
| `car-b.glb` | [Car](https://poly.pizza/m/unqqkULtRU) |
| `suv.glb` | [SUV](https://poly.pizza/m/xsMtZhBkxL) |
| `sports.glb` | [Sports Car](https://poly.pizza/m/1mkmFkAz5v) |

## Processing

Not the original downloads: `scripts/prepare-crowd-assets.mjs` merges each
model into one skinned mesh with a single palette texture (one draw call per
figure instead of ~10), drops props and every animation the crowd doesn't use
(for people: all but Idle, Idle_Neutral and Walk, and finger and scale
tracks; for the husky: all but Walk, Idle and Idle_2_HeadLow, renamed Sniff;
cars are merged whole, wheels included, since they're drawn instanced),
and meshopt-compresses the result — about 170 KB per character instead of
3 MB. Re-generate with:

```bash
node scripts/prepare-crowd-assets.mjs <folder with the source files, named as in the tables above>
```

## Not vendored

The facade texture (windows, sills, storey bands) is generated procedurally at
runtime by `frontend/src/three/facade.ts` rather than downloaded — it has to be
scaled in metres so that one window lands per storey on a building of any
height, which a photographed facade sheet cannot do.

Evergreen needles (`frontend/src/three/builders/needles.ts`) are plain
untextured geometry (thin triangles), not a texture at all — at the scale a
real needle is, no card size reads as anything but a printed pattern, so
there was no atlas to source here in the first place.
