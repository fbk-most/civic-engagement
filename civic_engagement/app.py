from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from civic_engagement.domain import DomainPack, register


def create_app(pack: DomainPack, title: str = "Civic Digital Twin PoC") -> FastAPI:
    """The API for one domain pack: the core's routes and the pack's own,
    all under /api."""
    register(pack)
    # Imported only now: they read the pack and the active site when
    # imported (see domain.py).
    from civic_engagement.api import (
        routes_cards,
        routes_interventions,
        routes_scenarios,
        routes_scene,
        routes_site_assets,
    )

    app = FastAPI(title=title)

    # Dev-only: Vite dev server runs on a different port than uvicorn.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    for router in (
        routes_scene.router,
        routes_site_assets.router,
        routes_cards.router,
        routes_interventions.router,
        routes_scenarios.router,
    ):
        app.include_router(router, prefix="/api")
    for router in pack.routers():
        app.include_router(router, prefix="/api")
    return app
