"""The rural app's API:

    uv run uvicorn rural_digital_twin.main:app --reload --port 8001
"""

from civic_engagement.app import create_app
from rural_digital_twin.pack import RuralPack

app = create_app(RuralPack())
