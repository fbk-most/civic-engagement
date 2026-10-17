from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from civic_engagement.api import routes_cards, routes_interventions, routes_scenarios, routes_scene

app = FastAPI(title="Civic Digital Twin PoC")

# Dev-only: Vite dev server runs on a different port than uvicorn.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes_scene.router, prefix="/api")
app.include_router(routes_cards.router, prefix="/api")
app.include_router(routes_interventions.router, prefix="/api")
app.include_router(routes_scenarios.router, prefix="/api")
