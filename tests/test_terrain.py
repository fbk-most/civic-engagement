import base64
import gzip
import json
import math

import numpy as np
import pytest
from fastapi import HTTPException

from civic_engagement import site_assets
from civic_engagement.config import SITE
from civic_engagement.geo_utils import to_projected
from civic_engagement.ingestion.raster import Grid, load_asc
from civic_engagement.ingestion.terrain import build_terrain_grid, fill_from_neighbours, sample_bilinear
from civic_engagement.local_frame import Anchor


def _heights(grid) -> np.ndarray:
    levels = np.frombuffer(base64.b64decode(grid.heights), dtype="<u2")
    return levels.reshape(grid.rows, grid.cols) * grid.height_scale_m


def _sloping_dtm(boundary_utm, step: float = 8.0, pad: float = 300.0) -> Grid:
    """A plane rising 1.5 m every 100 m east and 1 m every 100 m north."""
    minx, miny, maxx, maxy = boundary_utm.bounds
    origin_x = math.floor((minx - pad) / step) * step
    origin_y = math.ceil((maxy + pad) / step) * step
    ncols = math.ceil((maxx + pad - origin_x) / step) + 2
    nrows = math.ceil((origin_y - (miny - pad)) / step) + 2
    cx = origin_x + (np.arange(ncols) + 0.5) * step
    cy = origin_y - (np.arange(nrows) + 0.5) * step
    return Grid(origin_x, origin_y, step, step, 0.015 * cx[None, :] + 0.01 * cy[:, None])


def test_sample_bilinear_between_cell_centres() -> None:
    grid = Grid(0.0, 1.0, 1.0, 1.0, np.array([[10.0, 20.0], [30.0, 40.0]]))
    assert math.isclose(sample_bilinear(grid, np.array([1.0]), np.array([0.0]))[0], 25.0)
    # Past the edge: the edge's value.
    assert math.isclose(sample_bilinear(grid, np.array([-5.0]), np.array([5.0]))[0], 10.0)


def test_load_asc_reads_gz(tmp_path) -> None:
    text = "ncols 3\nnrows 2\nxllcorner 100\nyllcorner 200\ncellsize 0.5\nNODATA_value -9999\n1 2 3\n4 -9999 6\n"
    plain, packed = tmp_path / "dtm.asc", tmp_path / "dtm.asc.gz"
    plain.write_text(text)
    with gzip.open(packed, "wt") as f:
        f.write(text)
    a, b = load_asc(str(plain)), load_asc(str(packed))
    assert np.array_equal(a.array, b.array, equal_nan=True)
    assert np.isnan(b.array[1, 1]) and b.origin_y == 201.0


def test_missing_heights_continue_the_ground() -> None:
    heights = np.array([[1.0, 2.0, np.nan], [1.0, 2.0, np.nan], [np.nan, np.nan, np.nan]])
    filled = fill_from_neighbours(heights)
    assert np.isfinite(filled).all()
    assert filled[0, 0] == 1.0 and filled[1, 1] == 2.0
    assert 1.0 <= filled.min() and filled.max() <= 2.0


def test_terrain_grid_follows_the_dtm() -> None:
    boundary = to_projected(SITE.site_boundary_geojson)
    grid = build_terrain_grid(SITE, _sloping_dtm(boundary), cell_m=4.0, margin_m=20.0)
    heights = _heights(grid)
    assert heights.min() == 0
    # It covers the boundary and the margin, in the 3D frame (z south).
    anchor = Anchor.of(SITE.site_boundary_geojson)
    minx, min_north, maxx, max_north = anchor.local(SITE.site_boundary_geojson).bounds
    assert grid.x0 <= minx - 20 and grid.x0 + (grid.cols - 1) * grid.cell_m >= maxx + 20
    assert grid.z0 <= -max_north - 20 and grid.z0 + (grid.rows - 1) * grid.cell_m >= -min_north + 20
    # Rising east (along columns) and north (against rows), by the plane's slope
    # (within UTM's few per cent: its north is not quite true north here).
    assert math.isclose((heights[0, -1] - heights[0, 0]) / ((grid.cols - 1) * grid.cell_m), 0.015, rel_tol=0.05)
    assert math.isclose((heights[0, 0] - heights[-1, 0]) / ((grid.rows - 1) * grid.cell_m), 0.01, rel_tol=0.05)


def test_site_assets_list_the_terrain_grid(tmp_path, monkeypatch) -> None:
    from civic_engagement.api.routes_site_assets import get_site_asset, get_site_assets

    path = tmp_path / "terrain_grid.json"
    monkeypatch.setattr(
        site_assets, "asset_files", lambda: {"terrain_grid": site_assets.AssetFile(path, "json", "application/json")}
    )
    # No file: a flat site, nothing listed.
    assert get_site_assets().assets == []
    with pytest.raises(HTTPException):
        get_site_asset("terrain_grid")

    grid = build_terrain_grid(SITE, _sloping_dtm(to_projected(SITE.site_boundary_geojson)), cell_m=10.0, margin_m=0.0)
    path.write_text(json.dumps(grid.model_dump(mode="json")))
    (asset,) = get_site_assets().assets
    assert asset.key == "terrain_grid"
    assert asset.metadata == {"cols": grid.cols, "rows": grid.rows, "cell_m": 10.0}
    response = get_site_asset("terrain_grid", v=asset.version)
    assert response.path == path
    assert "immutable" in response.headers["cache-control"]


def test_cell_mean_averages_out_detail_finer_than_the_cell() -> None:
    # Furrows 1 m apart (0.5 m cells, alternately 0 and 1 m high): a point
    # sample lands on a furrow or between two; the cell's mean doesn't.
    from civic_engagement.ingestion.terrain import sample_cell_mean

    furrows = np.tile(np.array([0.0, 1.0]), (40, 20))
    grid = Grid(0.0, 20.0, 0.5, 0.5, furrows)
    x = np.array([5.25, 6.25, 7.75])
    y = np.array([10.0, 10.0, 10.0])
    assert np.allclose(sample_cell_mean(grid, x, y, 5.0), 0.5, atol=0.05)


def test_filling_a_gap_leaves_no_streaks() -> None:
    # A plane with a band of no data across it: filled, the band is the plane.
    rows, cols = np.mgrid[0:40, 0:60]
    plane = 0.3 * cols + 0.1 * rows
    gappy = plane.copy()
    gappy[10:25, :] = np.nan
    filled = fill_from_neighbours(gappy)
    band = filled[10:25]
    # Close to the plane away from the grid's sides (where nothing beyond
    # tells which way the ground goes), and smooth along the band: no streaks.
    assert np.abs(band - plane[10:25])[:, 8:-8].max() < 0.6
    assert np.abs(np.diff(band, n=2, axis=1)).max() < 0.1


def _slope(rows: int = 40, cols: int = 40, cell: float = 5.0) -> np.ndarray:
    """A hillside rising 0.5 m a metre towards +z (35% across a road along x)."""
    return np.tile((np.arange(rows) * cell * 0.5)[:, None], (1, cols))


def test_a_road_is_a_level_shelf_across_the_slope() -> None:
    from civic_engagement.ingestion.terrain import TerrainLine, shape_under_lines

    heights = _slope()
    road = np.array([[10.0, 100.0], [190.0, 100.0]])
    shaped = shape_under_lines(heights, 0.0, 0.0, 5.0, [road], [TerrainLine([], 3.0, 15.0)])
    # Within half the width and a cell of the road (rows 19-21): level, at
    # the road's height; far from it, the slope untouched.
    across = shaped[19:22, 10:30]
    assert np.ptp(across) < 1e-6 and abs(across.mean() - 50.0) < 1e-6
    assert np.array_equal(shaped[:12], heights[:12]) and np.array_equal(shaped[29:], heights[29:])


def test_water_only_runs_downhill() -> None:
    from civic_engagement.ingestion.terrain import TerrainLine, shape_under_lines

    heights = _slope()
    # Down the slope, with a 3 m hump half way.
    heights[18:22, 18:22] += 3.0
    stream = np.array([[100.0, 180.0], [100.0, 10.0]])
    shaped = shape_under_lines(heights, 0.0, 0.0, 5.0, [stream], [TerrainLine([], 1.5, 15.0, downhill=True)])
    along = shaped[2:37, 20]
    assert np.all(np.diff(along) >= -1e-9)  # rows go up the slope: never falling going uphill means never rising downstream
