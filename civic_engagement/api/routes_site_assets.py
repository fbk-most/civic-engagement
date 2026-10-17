from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from civic_engagement.models.schema import SiteAssets
from civic_engagement import site_assets

router = APIRouter()


@router.get("/site-assets", response_model=SiteAssets)
def get_site_assets() -> SiteAssets:
    return site_assets.site_assets()


@router.get("/site-assets/{key}")
def get_site_asset(key: str, v: str | None = None) -> FileResponse:
    """The asset's file. Asked for with its current version (`v`, see
    `site_assets`), it is cached for good: a new version is a new URL."""
    file = site_assets.asset_files().get(key)
    if file is None or not file.path.is_file():
        raise HTTPException(status_code=404, detail=f"The site has no {key!r} asset")
    headers = {"Cache-Control": "public, max-age=31536000, immutable"} if v else {"Cache-Control": "no-cache"}
    return FileResponse(file.path, media_type=file.media_type, headers=headers)
