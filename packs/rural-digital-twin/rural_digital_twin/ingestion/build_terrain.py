"""Builds the Bocenago site's terrain grid from its DTM (see the core's
ingestion/terrain.py): data/bocenago/lidar/dtm.asc.gz, PAT's downloads
combined (see SOURCE.txt there), every 5 m — plenty for a valley, and a
quarter of the points of a 2 m grid over 8 km².

    uv run python -m rural_digital_twin.ingestion.build_terrain [--cell 5 ...]
"""

import sys

from civic_engagement.domain import register
from civic_engagement.ingestion import terrain
from rural_digital_twin.pack import RuralPack
from rural_digital_twin.sites import DATA_DIR

if __name__ == "__main__":
    register(RuralPack())
    # Defaults first: what's on the command line overrides them.
    terrain.main(["--dtm", f"{DATA_DIR}/lidar/dtm.asc.gz", "--cell", "5", *sys.argv[1:]])
