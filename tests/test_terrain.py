import base64
import json
import math

import numpy as np
import pytest
from fastapi import HTTPException

from civic_engagement import site_assets
from civic_engagement.config import SITE
from civic_engagement.geo_utils import to_projected
from civic_engagement.ingestion.raster import Grid
from civic_engagement.ingestion.terrain import build_terrain_grid, sample_bilinear
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
