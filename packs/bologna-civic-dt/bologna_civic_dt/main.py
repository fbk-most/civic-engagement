"""The urban app's API:

    uv run uvicorn bologna_civic_dt.main:app --reload
"""

from bologna_civic_dt.pack import UrbanPack
from civic_engagement.app import create_app

app = create_app(UrbanPack())
