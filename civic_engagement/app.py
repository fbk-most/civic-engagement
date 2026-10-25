import os
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from starlette.types import Scope

from civic_engagement.domain import DomainPack, register


class _Frontend(StaticFiles):
    """The built app. Vite names its bundles after their content
    (assets/<name>-<hash>.js): cached for good; everything else, index.html
    first, checked again on every load, so a new build shows at once."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        immutable = path.startswith("assets/") and response.status_code == 200
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if immutable else "no-cache"
        return response


def create_app(pack: DomainPack, title: str = "Civic Digital Twin PoC", frontend: str | Path | None = None) -> FastAPI:
    """The API for one domain pack: the core's routes and the pack's own,
    all under /api.

    `frontend` (or `CIVIC_ENGAGEMENT_FRONTEND`): the pack's built app, its
    `frontend/dist`, served at / — one origin for the app and the API, as
    in a container. Without it, in development, the app is Vite's, which
    proxies /api here."""
    register(pack)
    # Imported only now: they read the pack and the active site when
    # imported (see domain.py).
    from civic_engagement.access import access, check_configuration, team_store
    from civic_engagement.api import (
        routes_admin,
        routes_auth,
        routes_cards,
        routes_interventions,
        routes_scenarios,
        routes_scene,
        routes_site_assets,
    )
    from civic_engagement.config import SITE, auth_mechanism
    from civic_engagement.store.state import store

    # With teams: refuses to start without its secrets; reads every team's
    # session now, not on its first request.
    check_configuration()
    if auth_mechanism() == "pin":
        for team in team_store().teams():
            store.load(team.id)

    if frontend is None:
        frontend = os.environ.get("CIVIC_ENGAGEMENT_FRONTEND") or None

    app = FastAPI(title=title)

    if frontend is None:
        # Development only: the Vite dev server runs on a different port
        # than uvicorn.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["http://localhost:5173"],
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # Every route, the pack's too, behind `access`: with teams, a valid
    # token for each, with no exceptions to remember but logging in, the
    # manager's (their own credentials) and /health.
    for router in (
        routes_scene.router,
        routes_site_assets.router,
        routes_cards.router,
        routes_interventions.router,
        routes_scenarios.router,
        *pack.routers(),
    ):
        app.include_router(router, prefix="/api", dependencies=[Depends(access)])
    app.include_router(routes_auth.router, prefix="/api")
    if auth_mechanism() == "pin":
        app.include_router(routes_admin.router, prefix="/api")

    @app.get("/api/health")
    def health() -> dict[str, str]:
        """Up, with the site's teams and sessions loaded (above)."""
        return {"status": "ok", "site": SITE.site_id}

    if frontend is not None:
        # Last: the API's routes come first.
        app.mount("/", _Frontend(directory=frontend, html=True), name="frontend")
    return app
