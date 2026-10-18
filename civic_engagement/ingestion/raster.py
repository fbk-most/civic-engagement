"""Shared plumbing for sampling a georeferenced grid (an ESRI ASCII LiDAR
raster, or a cropped orthophoto with a hand-written sidecar — see lidar.py
and ortofoto.py) under a building footprint.

Both raster kinds reduce to the same shape once loaded: a north-up array
(row 0 = the raster's north edge) plus an origin and pixel size, so one
polygon-to-pixel-mask routine serves both.
"""

import gzip
from dataclasses import dataclass

import numpy as np
from shapely.geometry.base import BaseGeometry


@dataclass
class Grid:
    origin_x: float
    origin_y: float
    pixel_size_x: float
    pixel_size_y: float
    array: np.ndarray  # [row, col, ...]; row 0 is the north edge (origin_y)


def load_asc(path: str) -> Grid:
    """Parses an ESRI ASCII grid (the format PAT's LiDAR portal exports as).
    Six header lines, then whitespace-separated values, row-major from the
    north-west corner — already exactly the `Grid` convention above. A
    `.gz` file is read compressed.
    """
    with (gzip.open(path, "rt") if path.endswith(".gz") else open(path)) as f:
        header = {}
        for _ in range(6):
            key, value = f.readline().split()
            header[key.lower()] = float(value)
        array = np.loadtxt(f)
    nodata = header["nodata_value"]
    array = np.where(array == nodata, np.nan, array)
    return Grid(
        origin_x=header["xllcorner"],
        origin_y=header["yllcorner"] + header["nrows"] * header["cellsize"],
        pixel_size_x=header["cellsize"],
        pixel_size_y=header["cellsize"],
        array=array,
    )


def sample_polygon(polygon_utm: BaseGeometry, grid: Grid, erode_m: float = 0.5) -> np.ndarray:
    """Cell values whose centres fall inside `polygon_utm` (in the grid's own
    CRS). Eroded slightly first so wall-edge pixels — a 50/50 mix of roof and
    street below — don't get counted as roof; falls back to the un-eroded
    polygon for footprints too small to survive that (a few small canopies in
    this baseline). Returns an empty array if nothing lands inside.
    """
    import shapely

    shrunk = polygon_utm.buffer(-erode_m)
    if shrunk.is_empty:
        shrunk = polygon_utm

    minx, miny, maxx, maxy = polygon_utm.bounds
    nrows, ncols = grid.array.shape[:2]
    col_lo = max(int((minx - grid.origin_x) / grid.pixel_size_x) - 1, 0)
    col_hi = min(int((maxx - grid.origin_x) / grid.pixel_size_x) + 2, ncols)
    row_lo = max(int((grid.origin_y - maxy) / grid.pixel_size_y) - 1, 0)
    row_hi = min(int((grid.origin_y - miny) / grid.pixel_size_y) + 2, nrows)
    if col_lo >= col_hi or row_lo >= row_hi:
        return grid.array[0:0]

    cols = np.arange(col_lo, col_hi)
    rows = np.arange(row_lo, row_hi)
    xs = grid.origin_x + (cols + 0.5) * grid.pixel_size_x
    ys = grid.origin_y - (rows + 0.5) * grid.pixel_size_y
    xx, yy = np.meshgrid(xs, ys)

    mask = shapely.contains_xy(shrunk, xx, yy)
    return grid.array[row_lo:row_hi, col_lo:col_hi][mask]
