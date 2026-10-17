"""The urban pack's own API routes, next to the core's (see
civic_engagement/domain.py's `DomainPack.routers`)."""

from fastapi import APIRouter, HTTPException

from bologna_civic_dt.felt_field import calendar_date, thermal_field
from bologna_civic_dt.types import ThermalFieldResponse

router = APIRouter()


@router.get("/thermal-field", response_model=ThermalFieldResponse)
def get_thermal_field(t: int = 0, month: int = 6, day: int = 21, as_is: bool = False) -> ThermalFieldResponse:
    """Felt temperature across the site, hour by hour, on one day of year t
    — with the session's interventions, or without any (`as_is`)."""
    from civic_engagement.scene import validated_t

    t = validated_t(t)
    try:
        calendar_date(t, month, day)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return thermal_field(t, month, day, as_is=as_is)
