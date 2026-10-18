"""The felt-temperature field: the sun where the 3D view puts it, and shade
where something stands between a cell and the sun."""

from datetime import date, datetime
from zoneinfo import ZoneInfo

import numpy as np
import pytest

from bologna_civic_dt.solar import Day, sun_position
from bologna_civic_dt.thermal_field import sun_exposure

TRENTO = (46.072, 11.121)


@pytest.mark.parametrize(
    "when, altitude, azimuth",
    [
        # suncalc's getPosition (the frontend's), TZ=Europe/Rome.
        ((2026, 6, 21, 15), 59.3507, 231.1773),
        ((2026, 12, 21, 9), 7.9473, 136.1844),
        ((2026, 3, 21, 18), 4.4164, 266.2215),
    ],
)
def test_sun_position_matches_suncalc(when, altitude, azimuth) -> None:
    instant = datetime(*when, tzinfo=ZoneInfo("Europe/Rome"))
    alt, az = sun_position(instant, *TRENTO)
    assert alt == pytest.approx(altitude, abs=1e-3)
    assert az == pytest.approx(azimuth, abs=1e-3)


def test_typical_day_is_warmest_mid_afternoon() -> None:
    day = Day(date(2026, 7, 15), *TRENTO)
    assert int(np.argmax(day.air_temperature)) == 15
    assert day.direct[2] == 0 and day.direct[13] > 800


def test_climate_warms_summer_most_then_keeps_trending() -> None:
    today = Day(date(2026, 7, 15), *TRENTO).air_temperature
    assert Day(date(2026, 7, 15), *TRENTO, years_ahead=5).air_temperature == pytest.approx(today + 1.0)
    assert Day(date(2026, 7, 15), *TRENTO, years_ahead=10).air_temperature == pytest.approx(today + 2.0)
    assert Day(date(2026, 7, 15), *TRENTO, years_ahead=20).air_temperature == pytest.approx(today + 2.5)
    winter = Day(date(2026, 1, 15), *TRENTO).air_temperature
    assert Day(date(2026, 1, 15), *TRENTO, years_ahead=10).air_temperature == pytest.approx(winter + 0.5)


def _exposure(building_height, crown_low=None, crown_high=None, extinction=None, altitude=45.0, azimuth=180.0):
    shape = building_height.shape
    zeros = np.zeros(shape)
    out = sun_exposure(
        np.array([altitude]), np.array([azimuth]), building_height,
        zeros if crown_low is None else crown_low, zeros if crown_high is None else crown_high,
        zeros if extinction is None else extinction, np.ones((shape[0] - 20, shape[1] - 20)), 1.1,
    )
    return out[0]


def test_building_shades_the_side_away_from_the_sun() -> None:
    # A 10 m wall along row 30 of a 61 x 61 occluder grid (row 0 = south);
    # the field is the inner 41 x 41, offset by 10 cells. Sun due south at 45°.
    height = np.zeros((61, 61))
    height[30, :] = 10.0
    lit = _exposure(height)
    # Field row r is occluder row r + 10: north of the wall (rows 31-38,
    # within 8.9 m) in shade, south of it in full sun.
    assert np.all(lit[21:29, :] == 0.0)
    assert np.all(lit[:20, :] == 1.0)
    assert np.all(lit[30:, :] == 1.0)


def test_crown_dims_without_blocking() -> None:
    zeros = np.zeros((61, 61))
    low, high, ext = zeros.copy(), zeros.copy(), zeros.copy()
    low[28:33, 28:33], high[28:33, 28:33], ext[28:33, 28:33] = 3.0, 8.0, 0.35
    lit = _exposure(zeros, low, high, ext, altitude=90.0 - 1e-6)
    # Straight below the crown: 5 m of crown crossed.
    assert lit[20, 20] == pytest.approx(np.exp(-0.35 * 5), rel=0.05)
    assert lit[0, 0] == 1.0
