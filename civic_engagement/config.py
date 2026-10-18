"""Site configuration: the fields every site has, and the active site.

The sites themselves are declared by the domain pack (see domain.py), each
as a `SiteConfig` or a subclass with the pack's own fields. Every module
reads the *active* site off `SITE` rather than importing constants
directly.

The app supports exactly one active site per process — switching sites
means relaunching with a different `CIVIC_ENGAGEMENT_SITE` env var (the pack's
default site if unset), not a live in-app switcher.
"""

import os
from dataclasses import dataclass
from functools import cache
from typing import cast


@dataclass(frozen=True, kw_only=True)
class SiteConfig:
    site_id: str
    name: str

    site_boundary_geojson: dict
    # "surveyed": the boundary is real digitized/sourced data.
    # "provisional": a placeholder (e.g. a plain circle) standing in until
    # real data is digitized.
    boundary_status: str

    # Every per-site file lives under data/<data_dir>/ — this is the single
    # source of truth for that layout; the paths below all derive from it
    # rather than being configured independently, so two sites can never
    # accidentally collide on the same file.
    data_dir: str = ""

    @property
    def baseline_json_path(self) -> str:
        return f"{self.data_dir}/baseline.json"

    @property
    def session_json_path(self) -> str:
        return f"{self.data_dir}/session.json"

    # Optional LiDAR/orthophoto inputs for a pack's baseline ingestion — gitignored,
    # since they're either downloaded by hand from a regional geoportal or
    # supplied directly (see the ingestion/lidar.py and ortofoto.py module
    # docstrings for the exact file format expected). Both are optional at
    # runtime: the urban pack's build_baseline.py degrades gracefully to OSM-tag-only
    # height/roof-shape logic when absent.
    @property
    def lidar_dbm_path(self) -> str:
        return f"{self.data_dir}/lidar/dbm.asc"

    @property
    def lidar_dtm_path(self) -> str:
        return f"{self.data_dir}/lidar/dtm.asc"

    @property
    def ortofoto_png_path(self) -> str:
        return f"{self.data_dir}/ortofoto/site.png"

    @property
    def ortofoto_sidecar_path(self) -> str:
        return f"{self.data_dir}/ortofoto/site.json"

    # Built from the DTM by ingestion/terrain.py, and committed. A site
    # without one is flat.
    @property
    def terrain_grid_path(self) -> str:
        return f"{self.data_dir}/terrain/terrain_grid.json"


# UTM zone 32N — both current sites (Trento, Bologna) fall inside it, so
# this stays a single global rather than a per-site field. A future site
# outside 6-12°E would need this promoted onto SiteConfig.
PROJECTED_CRS = "+proj=utm +zone=32 +ellps=WGS84 +datum=WGS84 +units=m +no_defs"
WGS84_CRS = "EPSG:4326"


@cache
def active_site() -> SiteConfig:
    """The site this process serves, among the registered pack's sites."""
    from civic_engagement.domain import active_pack

    pack = active_pack()
    site_id = os.environ.get("CIVIC_ENGAGEMENT_SITE", pack.default_site)
    if site_id not in pack.sites:
        raise KeyError(f"Unknown CIVIC_ENGAGEMENT_SITE {site_id!r}; the {pack.id!r} pack has: {', '.join(pack.sites)}")
    return pack.sites[site_id]


class _ActiveSite:
    """`SITE`: reads through to `active_site()`, so that modules can import
    it before the pack is registered and read it after."""

    def __getattr__(self, name: str):
        return getattr(active_site(), name)


SITE = cast(SiteConfig, _ActiveSite())
