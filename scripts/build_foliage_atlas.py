"""One-off script: turn an ambientCG CC0 leaf set into the compact foliage-card
atlas the 3D view instances for tree crowns.

    uv run --with pillow --with numpy python scripts/build_foliage_atlas.py \
        /path/to/LeafSet005_1K-PNG

Why this exists rather than shipping the source download directly:

- The source is ~8 MB across six maps (colour, opacity, normal, displacement,
  roughness) at 1024x512. The renderer only needs colour + alpha, and only the
  parts of the sheet that actually contain a dense leaf cluster.
- Foliage renders with `alphaTest`, so texels that are fully transparent still
  contribute their *colour* to lower mip levels. The source has black in those
  texels, which fringes every leaf edge with dark halos as trees recede. The
  dilation pass below bleeds leaf colour outward into the transparent region so
  the mip chain stays clean.

Output: `frontend/public/assets/3d/foliage-atlas.png`, a 2x2 grid of the four
densest tiles, which `builders/vegetation.ts` samples one tile per card.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

TILE_PX = 256
GRID = 2  # 2x2 output
OUTPUT_PATH = Path("frontend/public/assets/3d/foliage-atlas.png")

# How far leaf colour is pushed into transparent texels. Only the first few
# pixels around each leaf need true dilation — beyond that the flat average
# fill takes over (see `dilate_colour`).
DILATION_PASSES = 6


def load_source(folder: Path) -> tuple[np.ndarray, np.ndarray]:
    colour_files = sorted(folder.glob("*_Color.png"))
    opacity_files = sorted(folder.glob("*_Opacity.png"))
    if not colour_files or not opacity_files:
        raise SystemExit(f"Expected *_Color.png and *_Opacity.png in {folder}")

    colour = np.asarray(Image.open(colour_files[0]).convert("RGB"), dtype=np.float32)
    alpha = np.asarray(Image.open(opacity_files[0]).convert("L"), dtype=np.float32)
    if colour.shape[:2] != alpha.shape:
        raise SystemExit("Colour and opacity maps differ in size")
    return colour, alpha


def pick_tiles(alpha: np.ndarray, count: int) -> list[tuple[int, int]]:
    """The densest non-overlapping tiles, so every card is a full cluster of
    leaves rather than a mostly-empty corner of the sheet."""
    height, width = alpha.shape
    scored = []
    for top in range(0, height - TILE_PX + 1, TILE_PX):
        for left in range(0, width - TILE_PX + 1, TILE_PX):
            coverage = (alpha[top : top + TILE_PX, left : left + TILE_PX] > 128).mean()
            scored.append((coverage, top, left))
    scored.sort(reverse=True)
    if len(scored) < count:
        raise SystemExit(f"Source only yields {len(scored)} tiles, need {count}")
    for coverage, top, left in scored[:count]:
        print(f"  tile ({left:4d},{top:4d}) coverage {coverage * 100:.1f}%")
    return [(top, left) for _, top, left in scored[:count]]


def dilate_colour(colour: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Bleeds colour outward from opaque texels into transparent ones.

    Seeded from *solidly* opaque texels only. Anti-aliased edge texels carry a
    blend of leaf and the sheet's pale background, and seeding from those
    propagates the background outward instead of the leaf — which makes crowns
    get lighter with distance rather than holding their colour.
    """
    known = alpha > 128
    result = colour.copy()

    # Everything starts as the average leaf colour, so any texel the dilation
    # doesn't reach still averages down to foliage green rather than to
    # whatever happens to border the empty space (rim-lit leaves, which are
    # much brighter than a crown's interior, otherwise dominate).
    result[~known] = colour[known].mean(axis=0)

    for _ in range(DILATION_PASSES):
        if known.all():
            break
        # Average of the four neighbours that already have a colour.
        total = np.zeros_like(result)
        weight = np.zeros(known.shape, dtype=np.float32)
        for axis, shift in ((0, 1), (0, -1), (1, 1), (1, -1)):
            shifted_colour = np.roll(result, shift, axis=axis)
            shifted_known = np.roll(known, shift, axis=axis)
            total += shifted_colour * shifted_known[..., None]
            weight += shifted_known
        fillable = (~known) & (weight > 0)
        result[fillable] = total[fillable] / weight[fillable][..., None]
        known = known | fillable
    return result


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    folder = Path(sys.argv[1])

    colour, alpha = load_source(folder)
    print(f"Source {colour.shape[1]}x{colour.shape[0]}, alpha coverage "
          f"{(alpha > 128).mean() * 100:.1f}%")

    print("Picking tiles:")
    tiles = pick_tiles(alpha, GRID * GRID)

    colour = dilate_colour(colour, alpha)

    size = TILE_PX * GRID
    out = np.zeros((size, size, 4), dtype=np.uint8)
    for index, (top, left) in enumerate(tiles):
        row, column = divmod(index, GRID)
        target = (slice(row * TILE_PX, (row + 1) * TILE_PX),
                  slice(column * TILE_PX, (column + 1) * TILE_PX))
        source = (slice(top, top + TILE_PX), slice(left, left + TILE_PX))
        out[target + (slice(0, 3),)] = np.clip(colour[source], 0, 255).astype(np.uint8)
        out[target + (3,)] = np.clip(alpha[source], 0, 255).astype(np.uint8)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(out, mode="RGBA").save(OUTPUT_PATH, optimize=True)
    print(f"Wrote {OUTPUT_PATH} ({size}x{size}, {OUTPUT_PATH.stat().st_size / 1e3:.0f} kB)")


if __name__ == "__main__":
    main()
