"""The rural sites: one for now, Bocenago, a municipality in the Rendena
valley (Giudicarie, Trentino), from the valley floor at about 700 m up the
eastern slope to about 2,000 m.

Its boundary is the municipality's, from OpenStreetMap
(data/bocenago/boundary.geojson, written by ingestion/build_baseline.py).
"""

import json
from pathlib import Path
from typing import cast

from civic_engagement.config import SITE as _SITE
from civic_engagement.config import SiteConfig

DATA_DIR = "data/bocenago"


def _boundary(data_dir: str) -> dict:
    path = Path(data_dir) / "boundary.geojson"
    return json.loads(path.read_text())["geometry"] if path.is_file() else {"type": "Polygon", "coordinates": []}


SITES: dict[str, SiteConfig] = {
    "bocenago": SiteConfig(
        site_id="bocenago",
        name="Bocenago",
        site_boundary_geojson=_boundary(DATA_DIR),
        boundary_status="surveyed",
        data_dir=DATA_DIR,
    ),
}

DEFAULT_SITE = "bocenago"

# The active site (see the core's config.py).
SITE = cast(SiteConfig, _SITE)
