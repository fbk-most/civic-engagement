"""Builds the site's terrain grid (see models/schema.py's `TerrainGrid`)
from its LiDAR DTM: the ground's height on a regular grid of points over
the site and a margin around it, in the 3D view's local frame. A site
without one is flat (see site_assets.py).

Meant for drawing and walking on, not as a survey product: a 2 m grid is
plenty for a valley, and a flat-ish town square is better left without one.
A pack runs it for its own sites (`main`, with the pack registered).

The margin should cover what the scene draws past the boundary (the urban
pack's buildings, up to its building fetch buffer). Past the DTM's edge,
heights repeat the edge's; where it has no data, they continue the known
ground smoothly.

Each point's height is the DTM's mean over the point's cell, not the DTM's
height at the point: sampled once a cell, the DTM's detail finer than the
grid (furrows, mowing strips, survey noise) comes out as ripples a few
cells long — aliasing.

Lines drawn on the ground — roads, paths, streams — can shape the grid
under them (`TerrainLine`, `shape_under_lines`): a road is a level shelf
cut into the slope, which a grid of a few metres doesn't show, so a ribbon
laid on the bare grid leans with the slope and climbs its banks.
"""

import argparse
import base64
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pyproj
import shapely

from civic_engagement.config import PROJECTED_CRS, SITE, WGS84_CRS, SiteConfig
from civic_engagement.ingestion.raster import Grid, load_asc
from civic_engagement.local_frame import Anchor
from civic_engagement.models.schema import TerrainGrid

HEIGHT_SCALE_M = 0.05
_MAX_LEVEL = 65535


def sample_bilinear(grid: Grid, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """The raster's value at projected points (x, y), interpolated between
    cell centres; past the raster's edge, the edge's value. NaN where a
    nodata cell is involved."""
    nrows, ncols = grid.array.shape[:2]
    col = np.clip((x - grid.origin_x) / grid.pixel_size_x - 0.5, 0, ncols - 1)
    row = np.clip((grid.origin_y - y) / grid.pixel_size_y - 0.5, 0, nrows - 1)
    c0 = np.minimum(np.floor(col).astype(int), ncols - 2)
    r0 = np.minimum(np.floor(row).astype(int), nrows - 2)
    tx = col - c0
    ty = row - r0
    a = grid.array
    top = a[r0, c0] * (1 - tx) + a[r0, c0 + 1] * tx
    bottom = a[r0 + 1, c0] * (1 - tx) + a[r0 + 1, c0 + 1] * tx
    return top * (1 - ty) + bottom * ty


def sample_cell_mean(grid: Grid, x: np.ndarray, y: np.ndarray, cell_m: float) -> np.ndarray:
    """The raster's mean over the square `cell_m` across centred on each
    projected point (x, y), from samples a raster cell apart; NaN where
    none of them has data."""
    n = max(1, round(cell_m / grid.pixel_size_x))
    offsets = (np.arange(n) + 0.5) / n * cell_m - cell_m / 2
    total = np.zeros(np.shape(x))
    count = np.zeros(np.shape(x))
    for dx in offsets:
        for dy in offsets:
            values = sample_bilinear(grid, x + dx, y + dy)
            known = np.isfinite(values)
            total[known] += values[known]
            count[known] += 1
    with np.errstate(invalid="ignore"):
        return np.where(count > 0, total / np.maximum(count, 1), np.nan)


def fill_from_neighbours(heights: np.ndarray, smoothing: int = 200) -> np.ndarray:
    """`heights` with each NaN replaced by a smooth continuation of the
    known ground: from ever coarser means of the known points, refined level
    by level (each level's gaps from the coarser one, blurred), then relaxed
    `smoothing` times to the mean of their four neighbours (the known points
    staying put). Neither a cliff nor streaks."""
    heights = heights.copy()
    unknown = np.isnan(heights)
    if unknown.all():
        raise ValueError("No known heights to fill from")
    if unknown.any():
        heights[unknown] = _coarse_fill(heights)[unknown]
    for _ in range(smoothing if unknown.any() else 0):
        padded = np.pad(heights, 1, mode="edge")
        mean = (padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:]) / 4
        heights[unknown] = mean[unknown]
    return heights


def _coarse_fill(heights: np.ndarray) -> np.ndarray:
    """`heights` with its NaNs from the next coarser level (2x2 means of the
    known points), itself filled the same way; upsampled smoothly."""
    if not np.isnan(heights).any():
        return heights
    rows, cols = heights.shape
    padded = np.pad(heights, ((0, rows % 2), (0, cols % 2)), constant_values=np.nan)
    blocks = padded.reshape(padded.shape[0] // 2, 2, padded.shape[1] // 2, 2)
    known = np.isfinite(blocks).sum(axis=(1, 3))
    with np.errstate(invalid="ignore"):
        coarse = np.where(known > 0, np.nansum(blocks, axis=(1, 3)) / np.maximum(known, 1), np.nan)
    coarse = _coarse_fill(coarse) if coarse.size > 1 else coarse
    # Back up: each coarse value over its 2x2, then a 3x3 blur, so the
    # levels' blocks don't show.
    up = np.repeat(np.repeat(coarse, 2, axis=0), 2, axis=1)[:rows, :cols]
    padded_up = np.pad(up, 1, mode="edge")
    blurred = sum(padded_up[1 + dr : 1 + dr + rows, 1 + dc : 1 + dc + cols] for dr in (-1, 0, 1) for dc in (-1, 0, 1)) / 9
    return np.where(np.isnan(heights), blurred, heights)


@dataclass(frozen=True)
class TerrainLine:
    """A line on the ground that shapes the grid under it (see
    `shape_under_lines`): a road's or a stream's, say."""

    # Its points, (lng, lat).
    points: list[tuple[float, float]]
    width_m: float
    # Over how long a stretch its height is smoothed along it.
    smooth_m: float
    # Water: its height only ever goes down, from its higher end.
    downhill: bool = False


# Under a line, the grid points within half its width and a cell take its
# height — the corners of every cell the line's ribbon crosses, so the
# ribbon lies level across; beyond, the ground blends back into the slope
# over this many cells.
BLEND_CELLS = 1.5


def shape_under_lines(heights: np.ndarray, x0: float, z0: float, cell_m: float, lines: list[np.ndarray], specs: list[TerrainLine]) -> np.ndarray:
    """The grid's heights (rows from z0, columns from x0, metres) shaped
    under each line (its points in the local frame, x east and z south, with
    its spec): a shelf as wide as the line, level across, its height along
    the line the ground's smoothed (and only falling, for water), blended
    into the ground around it. Lines later in the list win where they meet."""
    heights = heights.copy()
    rows, cols = heights.shape
    for points, spec in zip(lines, specs):
        line = shapely.LineString(points)
        if line.length < cell_m:
            continue
        step = cell_m / 2
        along = np.append(np.arange(0, line.length, step), line.length)
        on_line = shapely.line_interpolate_point(line, along)
        profile = _grid_bilinear(heights, x0, z0, cell_m, shapely.get_x(on_line), shapely.get_y(on_line))
        window = max(1, round(spec.smooth_m / step)) | 1
        profile = _running(_running(profile, window, np.median), window, np.mean)
        if spec.downhill:
            falling = profile if profile[0] >= profile[-1] else profile[::-1]
            falling = np.minimum.accumulate(falling)
            profile = falling if profile[0] >= profile[-1] else falling[::-1]

        inner = spec.width_m / 2 + cell_m
        reach = inner + BLEND_CELLS * cell_m
        minx, minz, maxx, maxz = line.bounds
        c0 = max(0, math.floor((minx - reach - x0) / cell_m))
        c1 = min(cols - 1, math.ceil((maxx + reach - x0) / cell_m))
        r0 = max(0, math.floor((minz - reach - z0) / cell_m))
        r1 = min(rows - 1, math.ceil((maxz + reach - z0) / cell_m))
        if c1 < c0 or r1 < r0:
            continue
        rr, cc = np.mgrid[r0 : r1 + 1, c0 : c1 + 1]
        grid_points = shapely.points(x0 + cc.ravel() * cell_m, z0 + rr.ravel() * cell_m)
        distance = shapely.distance(grid_points, line)
        near = distance < reach
        if not near.any():
            continue
        target = np.interp(shapely.line_locate_point(line, grid_points[near]), along, profile)
        t = np.clip((distance[near] - inner) / (reach - inner), 0, 1)
        weight = 1 - t * t * (3 - 2 * t)
        r, c = rr.ravel()[near], cc.ravel()[near]
        heights[r, c] += weight * (target - heights[r, c])
    return heights


def _grid_bilinear(heights: np.ndarray, x0: float, z0: float, cell_m: float, x: np.ndarray, z: np.ndarray) -> np.ndarray:
    rows, cols = heights.shape
    gx = np.clip((x - x0) / cell_m, 0, cols - 1)
    gz = np.clip((z - z0) / cell_m, 0, rows - 1)
    c = np.minimum(np.floor(gx).astype(int), cols - 2)
    r = np.minimum(np.floor(gz).astype(int), rows - 2)
    tx, tz = gx - c, gz - r
    top = heights[r, c] * (1 - tx) + heights[r, c + 1] * tx
    bottom = heights[r + 1, c] * (1 - tx) + heights[r + 1, c + 1] * tx
    return top * (1 - tz) + bottom * tz


def _running(values: np.ndarray, window: int, reduce) -> np.ndarray:
    """`reduce` (np.median, np.mean) over a centred window, the ends
    repeated."""
    if window <= 1 or len(values) < 2:
        return values
    padded = np.pad(values, window // 2, mode="edge")
    return reduce(np.lib.stride_tricks.sliding_window_view(padded, window), axis=1)


def build_terrain_grid(
    site: SiteConfig, dtm: Grid, cell_m: float, margin_m: float, lines: list[TerrainLine] = ()
) -> TerrainGrid:
    """The grid over the site's boundary and `margin_m` around it, shaped
    under `lines`."""
    anchor = Anchor.of(site.site_boundary_geojson)
    minx, min_north, maxx, max_north = anchor.local(site.site_boundary_geojson).bounds
    # The 3D frame's z points south.
    minz, maxz = -max_north, -min_north
    x0 = math.floor((minx - margin_m) / cell_m) * cell_m
    z0 = math.floor((minz - margin_m) / cell_m) * cell_m
    cols = math.ceil((maxx + margin_m - x0) / cell_m) + 1
    rows = math.ceil((maxz + margin_m - z0) / cell_m) + 1

    xs, zs = np.meshgrid(x0 + np.arange(cols) * cell_m, z0 + np.arange(rows) * cell_m)
    lng, lat = anchor.lng_lat(xs.ravel(), -zs.ravel())
    px, py = pyproj.Transformer.from_crs(WGS84_CRS, PROJECTED_CRS, always_xy=True).transform(lng, lat)
    heights = sample_cell_mean(dtm, np.asarray(px), np.asarray(py), cell_m)

    heights = heights.reshape(rows, cols)
    if not np.isfinite(heights).any():
        raise RuntimeError("The DTM has no data over the site")
    missing = int((~np.isfinite(heights)).sum())
    if missing:
        print(f"Note: {missing} of {heights.size} points fall where the DTM has no data: filled, continuing the ground")
        heights = fill_from_neighbours(heights)
    if lines:
        local = []
        for line in lines:
            lng, lat = np.asarray(line.points, dtype=float).T
            east, north = anchor.east_north(lng, lat)
            local.append(np.column_stack((east, -np.asarray(north))))
        heights = shape_under_lines(heights, x0, z0, cell_m, local, list(lines))
    base = float(heights.min())
    levels = np.round((heights.ravel() - base) / HEIGHT_SCALE_M)
    if levels.max() > _MAX_LEVEL:
        raise RuntimeError(f"Height range {levels.max() * HEIGHT_SCALE_M:.0f} m doesn't fit the grid's encoding")

    return TerrainGrid(
        anchor_lng=anchor.lng0,
        anchor_lat=anchor.lat0,
        x0=x0,
        z0=z0,
        cols=cols,
        rows=rows,
        cell_m=cell_m,
        base_elevation_m=round(base, 2),
        height_scale_m=HEIGHT_SCALE_M,
        heights=base64.b64encode(levels.astype("<u2").tobytes()).decode("ascii"),
    )


def main(argv: list[str] | None = None, lines: list[TerrainLine] = ()) -> None:
    """Writes the active site's terrain grid, shaped under `lines`. The pack
    must be registered."""
    parser = argparse.ArgumentParser(description="Build the site's terrain grid from its DTM")
    parser.add_argument("--dtm", default=SITE.lidar_dtm_path, help="ESRI ASCII DTM (default: %(default)s)")
    parser.add_argument("--out", default=SITE.terrain_grid_path, help="Output file (default: %(default)s)")
    parser.add_argument("--cell", type=float, default=2.0, help="Grid spacing, metres (default: %(default)s)")
    parser.add_argument("--margin", type=float, default=150.0, help="Margin past the boundary, metres (default: %(default)s)")
    args = parser.parse_args(argv)
    if args.cell <= 0 or args.margin < 0:
        parser.error("--cell must be > 0 and --margin >= 0")

    grid = build_terrain_grid(SITE, load_asc(args.dtm), args.cell, args.margin, lines)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(grid.model_dump(mode="json")))
    span = np.frombuffer(base64.b64decode(grid.heights), dtype="<u2").max() * grid.height_scale_m
    print(
        f"Wrote {out}: {grid.cols}x{grid.rows} points every {grid.cell_m} m, "
        f"{grid.base_elevation_m:.1f}-{grid.base_elevation_m + span:.1f} m above sea level"
    )
