"""The site's assets: files the frontend loads apart from the scene, being
heavier and unchanged by the interventions — for now the terrain grid
(see ingestion/terrain.py). Each is listed with a version that changes with
its content, so the frontend can ask for it as `?v=<version>` and the
browser cache it for good.

A missing file is simply not listed: a site without a terrain grid is
flat.
"""

import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from civic_engagement.config import SITE
from civic_engagement.models.schema import SiteAsset, SiteAssets, TerrainGrid


@dataclass(frozen=True)
class AssetFile:
    path: Path
    format: str
    media_type: str


def asset_files() -> dict[str, AssetFile]:
    return {"terrain_grid": AssetFile(Path(SITE.terrain_grid_path), "json", "application/json")}


@lru_cache(maxsize=16)
def _describe(key: str, path: Path, mtime_ns: int, size: int) -> SiteAsset:
    content = path.read_bytes()
    metadata = {}
    if key == "terrain_grid":
        # Checked here rather than at every request: the file is served as is.
        grid = TerrainGrid(**json.loads(content))
        metadata = {"cols": grid.cols, "rows": grid.rows, "cell_m": grid.cell_m}
    return SiteAsset(
        key=key,
        format=asset_files()[key].format,
        bytes=size,
        version=hashlib.sha1(content).hexdigest()[:12],
        metadata=metadata,
    )


def site_assets() -> SiteAssets:
    assets = []
    for key, file in asset_files().items():
        if not file.path.is_file():
            continue
        stat = file.path.stat()
        assets.append(_describe(key, file.path, stat.st_mtime_ns, stat.st_size))
    return SiteAssets(site_id=SITE.site_id, assets=assets)
