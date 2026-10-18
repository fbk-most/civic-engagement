"""Builds the site's terrain grid (see models/schema.py's `TerrainGrid`)
from its LiDAR DTM: the ground's height on a regular grid of points over
the site and a margin around it, in the 3D view's local frame. A site
without one is flat (see site_assets.py).

Meant for drawing and walking on, not as a survey product: a 2 m grid is
plenty for a valley, and a flat-ish town square is better left without one.
A pack runs it for its own sites (`main`, with the pack registered).

The margin should cover what the scene draws past the boundary (the urban
pack's buildings, up to its building fetch buffer). Past the DTM's edge,
heights repeat the edge's; where it has no data, they're the nearest
known ones.
"""

import argparse
import base64
import json
import math
from pathlib import Path

import numpy as np
import pyproj

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


def fill_from_neighbours(heights: np.ndarray, smoothing: int = 400) -> np.ndarray:
    """`heights` with each NaN replaced: first, ring by ring from the known
    points inwards, by the mean of its known neighbours; then relaxed,
    `smoothing` times, to the mean of its four neighbours (the known points
    staying put). A smooth continuation of the ground rather than a cliff,
    without the streaks the rings alone leave."""
    heights = heights.copy()
    unknown = np.isnan(heights)
    while np.isnan(heights).any():
        missing = np.isnan(heights)
        padded = np.pad(heights, 1, constant_values=np.nan)
        neighbours = np.stack([
            padded[1 + dr : 1 + dr + heights.shape[0], 1 + dc : 1 + dc + heights.shape[1]]
            for dr in (-1, 0, 1) for dc in (-1, 0, 1) if (dr, dc) != (0, 0)
        ])
        count = np.isfinite(neighbours).sum(axis=0)
        reached = missing & (count > 0)
        heights[reached] = (np.nansum(neighbours, axis=0) / np.maximum(count, 1))[reached]
    for _ in range(smoothing if unknown.any() else 0):
        padded = np.pad(heights, 1, mode="edge")
        mean = (padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:]) / 4
        heights[unknown] = mean[unknown]
    return heights


def build_terrain_grid(site: SiteConfig, dtm: Grid, cell_m: float, margin_m: float) -> TerrainGrid:
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
    heights = sample_bilinear(dtm, np.asarray(px), np.asarray(py))

    heights = heights.reshape(rows, cols)
    if not np.isfinite(heights).any():
        raise RuntimeError("The DTM has no data over the site")
    missing = int((~np.isfinite(heights)).sum())
    if missing:
        print(f"Note: {missing} of {heights.size} points fall where the DTM has no data: filled from the nearest")
        heights = fill_from_neighbours(heights)
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


def main(argv: list[str] | None = None) -> None:
    """Writes the active site's terrain grid. The pack must be registered."""
    parser = argparse.ArgumentParser(description="Build the site's terrain grid from its DTM")
    parser.add_argument("--dtm", default=SITE.lidar_dtm_path, help="ESRI ASCII DTM (default: %(default)s)")
    parser.add_argument("--out", default=SITE.terrain_grid_path, help="Output file (default: %(default)s)")
    parser.add_argument("--cell", type=float, default=2.0, help="Grid spacing, metres (default: %(default)s)")
    parser.add_argument("--margin", type=float, default=150.0, help="Margin past the boundary, metres (default: %(default)s)")
    args = parser.parse_args(argv)
    if args.cell <= 0 or args.margin < 0:
        parser.error("--cell must be > 0 and --margin >= 0")

    grid = build_terrain_grid(SITE, load_asc(args.dtm), args.cell, args.margin)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(grid.model_dump(mode="json")))
    span = np.frombuffer(base64.b64decode(grid.heights), dtype="<u2").max() * grid.height_scale_m
    print(
        f"Wrote {out}: {grid.cols}x{grid.rows} points every {grid.cell_m} m, "
        f"{grid.base_elevation_m:.1f}-{grid.base_elevation_m + span:.1f} m above sea level"
    )
