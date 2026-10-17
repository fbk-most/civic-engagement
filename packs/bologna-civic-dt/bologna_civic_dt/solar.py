"""The sun and the weather of a day at the site, hour by hour: where the sun
is, how strongly it shines, how warm the air is, and how leafy deciduous
trees are — the inputs of the felt-temperature field (thermal_field.py).

The sun's position is a line-by-line port of suncalc's `getPosition`, which
the 3D view uses for its sun and shadows (frontend/src/three/sun.ts), so the
shade the field computes falls where the 3D view draws it. The leaf curve is
the 3D view's `leafDensity`, for the same reason.
"""

import math
from datetime import date, datetime, timedelta
from itertools import pairwise
from zoneinfo import ZoneInfo

import numpy as np

from bologna_civic_dt.parameters import (
    CLIMATE_RAMP_YEARS,
    CLIMATE_TREND_C_PER_YEAR,
    CLIMATE_WARMING_C,
    LEAF_DENSITY_BY_MONTH,
    SITE_TIMEZONE,
    TYPICAL_DAILY_TEMPERATURE_C,
    WARMEST_HOUR,
)

HOURS = 24

# --- sun position: suncalc's getPosition --------------------------------------------

_RAD = math.pi / 180
_DAY_MS = 1000 * 60 * 60 * 24
_J1970 = 2440588
_J2000 = 2451545


def _to_days(instant: datetime) -> float:
    return instant.timestamp() * 1000 / _DAY_MS - 0.5 + _J1970 - _J2000


def _delta_t(d: float) -> float:
    y = 2000 + d / 365.2425
    if y < 2005:
        t = y - 2000
        return 63.86 + t * (0.3345 + t * (-0.060374 + t * (0.0017275 + t * (651814e-9 + t * 2373599e-11))))
    if y < 2050:
        t = y - 2000
        return 62.92 + t * (0.32217 + t * 0.005589)
    t = (y - 1820) / 100
    return -20 + 32 * t * t - 0.5628 * (2150 - y)


def _sun_coords(d: float) -> tuple[float, float]:
    t = d / 36525
    l0 = _RAD * (280.46646 + t * (36000.76983 + t * 3032e-7))
    m = _RAD * (357.52911 + t * (35999.05029 - t * 1537e-7))
    sin_m, cos_m = math.sin(m), math.cos(m)
    c = _RAD * (
        (1.914602 - t * (0.004817 + t * 14e-6)) * sin_m
        + (0.019993 - 101e-6 * t) * 2 * sin_m * cos_m
        + 289e-6 * sin_m * (3 - 4 * sin_m * sin_m)
    )
    om = _RAD * (125.04 - 1934.136 * t)
    lon = l0 + c - _RAD * (0.00569 + 0.00478 * math.sin(om))
    e = _RAD * (23.439291 - t * (0.0130042 + t * (16e-8 - t * 504e-9))) + _RAD * 0.00256 * math.cos(om)
    return math.atan2(math.cos(e) * math.sin(lon), math.cos(lon)), math.asin(math.sin(e) * math.sin(lon))


def sun_position(instant: datetime, lat: float, lng: float) -> tuple[float, float]:
    """(altitude, azimuth) in degrees, azimuth clockwise from north —
    exactly what suncalc's getPosition answers (from release 2, which the
    frontend uses: refraction included, azimuth as a compass bearing)."""
    lw = _RAD * -lng
    phi = _RAD * lat
    d = _to_days(instant)
    ra, dec = _sun_coords(d + _delta_t(d) / 86400)
    h_angle = _RAD * (280.46061837 + 360.98564736629 * d) - lw - ra
    altitude = math.asin(math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(h_angle))
    azimuth = (
        math.atan2(math.sin(h_angle), math.cos(h_angle) * math.sin(phi) - math.tan(dec) * math.cos(phi)) / _RAD + 540
    ) % 360
    refraction = 2967e-7 / math.tan(max(altitude, 0) + 0.00312536 / (max(altitude, 0) + 0.08901179))
    return (altitude + refraction) / _RAD, azimuth


# --- clear-sky sunshine ---------------------------------------------------------------


def direct_irradiance(altitude_deg: float) -> float:
    """Direct beam on a surface facing the sun, W/m², on a clear day:
    Meinel's attenuation over Kasten and Young's air mass. 0 below the
    horizon."""
    if altitude_deg <= 0:
        return 0.0
    zenith = 90 - altitude_deg
    air_mass = 1 / (math.cos(zenith * _RAD) + 0.50572 * (96.07995 - zenith) ** -1.6364)
    return 1353 * 0.7 ** (air_mass**0.678)


# --- weather and season -------------------------------------------------------------


def _day_of_year_curve(table: dict[int, tuple[float, float]], day: date) -> tuple[float, float]:
    """A monthly table read on the 15th of each month, interpolated between
    them across the year (December wraps to January)."""
    year = day.year
    anchors = [(date(year, m, 15), table[m]) for m in range(1, 13)]
    anchors = [(date(year - 1, 12, 15), table[12]), *anchors, (date(year + 1, 1, 15), table[1])]
    for (d0, v0), (d1, v1) in pairwise(anchors):
        if d0 <= day <= d1:
            f = (day - d0).days / (d1 - d0).days
            return tuple(a + (b - a) * f for a, b in zip(v0, v1))  # type: ignore[return-value]
    raise ValueError(day)


def _sunrise_hour(day: date, lat: float, lng: float, tz: ZoneInfo) -> float:
    """Local hour at which the sun rises (minute precision)."""
    start = datetime(day.year, day.month, day.day, tzinfo=tz)
    for minute in range(12 * 60):
        if sun_position(start + timedelta(minutes=minute), lat, lng)[0] > -0.833:
            return minute / 60
    return 6.0


def climate_warming(day: date, years_ahead: int) -> float:
    """How much warmer than today's typical day the air is, °C, on this
    day `years_ahead` years from now (see CLIMATE_WARMING_C)."""
    if years_ahead <= 0:
        return 0.0
    table = {month: (value, value) for month, value in CLIMATE_WARMING_C.items()}
    full = _day_of_year_curve(table, day)[0]
    ramp = min(years_ahead, CLIMATE_RAMP_YEARS) / CLIMATE_RAMP_YEARS
    return full * ramp + CLIMATE_TREND_C_PER_YEAR * max(0, years_ahead - CLIMATE_RAMP_YEARS)


def air_temperature(day: date, sunrise: float, years_ahead: int = 0) -> np.ndarray:
    """Air temperature at each hour of a typical day, °C: the coolest at
    sunrise, the warmest at WARMEST_HOUR, cosine-shaped in between (the
    usual daily curve of a fair day), `years_ahead` years from now."""
    t_min, t_max = _day_of_year_curve(TYPICAL_DAILY_TEMPERATURE_C, day)
    warming = climate_warming(day, years_ahead)
    t_min, t_max = t_min + warming, t_max + warming
    mean, amplitude = (t_min + t_max) / 2, (t_max - t_min) / 2
    rise = WARMEST_HOUR - sunrise
    fall = 24 - rise
    values = []
    for hour in range(HOURS):
        since_peak = (hour - WARMEST_HOUR) % 24
        if since_peak < fall:
            phase = since_peak / fall  # 0 at the peak, 1 at the next sunrise
        else:
            phase = 1 + (since_peak - fall) / rise  # 1 at sunrise, 2 at the peak
        values.append(mean + amplitude * math.cos(math.pi * phase))
    return np.array(values)


def leaf_density(month: int) -> float:
    """0 (bare) to 1 (full canopy) for deciduous trees, by month — the 3D
    view's `leafDensity`, which also works by month only."""
    points = LEAF_DENSITY_BY_MONTH
    if month <= points[0][0]:
        return points[0][1]
    for (m0, v0), (m1, v1) in pairwise(points):
        if month <= m1:
            return v0 + (v1 - v0) * (month - m0) / (m1 - m0)
    return points[-1][1]


class Day:
    """One day at the site, hour by hour (0-23, local civil time),
    `years_ahead` years from now (for the climate, see `climate_warming`)."""

    def __init__(self, day: date, lat: float, lng: float, years_ahead: int = 0) -> None:
        tz = ZoneInfo(SITE_TIMEZONE)
        positions = [
            sun_position(datetime(day.year, day.month, day.day, hour, tzinfo=tz), lat, lng) for hour in range(HOURS)
        ]
        self.date = day
        self.altitude = np.array([p[0] for p in positions])
        self.azimuth = np.array([p[1] for p in positions])
        self.direct = np.array([direct_irradiance(a) for a in self.altitude])
        self.air_temperature = air_temperature(day, _sunrise_hour(day, lat, lng, tz), years_ahead)
        self.leaf_density = leaf_density(day.month)
