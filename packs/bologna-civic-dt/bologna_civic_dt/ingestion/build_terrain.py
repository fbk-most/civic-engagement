"""Builds the active site's terrain grid from its DTM (see the core's
ingestion/terrain.py). Piazza Dante's is committed; a site without one is
flat.

    uv run python -m bologna_civic_dt.ingestion.build_terrain --dtm data/piazza_dante/lidar/dtm_2014.asc
"""

from bologna_civic_dt.pack import UrbanPack
from civic_engagement.domain import register
from civic_engagement.ingestion import terrain

if __name__ == "__main__":
    register(UrbanPack())
    terrain.main()
