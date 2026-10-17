"""Geometry functors of the urban model: plain shapely computations the
model calls through `@functions` (see model.py), written against their own
axes only — `cdt_compat.on_axes` adapts them to the evaluation layout.

Coordinates are in metres, in the projected CRS (`config.PROJECTED_CRS`).
Each computation mirrors exactly what the indicators did before the model
moved to civic-digital-twins (same shapely calls, same order), so the
numbers stay the same.
"""

import numpy as np
from shapely.geometry import Point
from shapely.ops import unary_union

from bologna_civic_dt.cdt_compat import arrays_to_geometries


def _site(site_wkb: np.ndarray):
    return arrays_to_geometries(site_wkb, np.array([0, site_wkb.size]))[0]


def _coverage(site, xs, ys, radius) -> float:
    """% of the site within `radius` of any of the points."""
    if site.area == 0 or len(xs) == 0:
        return 0.0
    covered = unary_union([Point(x, y).buffer(radius) for x, y in zip(xs, ys)]).intersection(site)
    return 100 * covered.area / site.area


def _by_active_set(years: np.ndarray, start: np.ndarray, compute) -> np.ndarray:
    """`compute(active)` for every year, computed once per distinct set of
    active entries (they only change in the years something is placed)."""
    cache: dict[bytes, float | np.ndarray] = {}
    values = []
    for t in years:
        active = start <= t
        key = active.tobytes()
        if key not in cache:
            cache[key] = compute(active)
        values.append(cache[key])
    return np.stack([np.asarray(v, dtype=float) for v in values], axis=-1)


def lit_share(years, x, y, start, radius, site_wkb) -> np.ndarray:
    """Per year: % of the site within `radius` of at least one active
    streetlight. Axes: (time,)."""
    site = _site(site_wkb)
    radius = float(radius)
    return _by_active_set(years, start, lambda active: _coverage(site, x[active], y[active], radius))


def shelter_reach(x, y, radius, site_wkb) -> np.ndarray:
    """Per shelter: % of the site within its own radius. Axes: (shelter,)."""
    site = _site(site_wkb)
    return np.array([_coverage(site, [px], [py], float(r)) for px, py, r in zip(x, y, radius)])


def cover_areas(years, cover_wkb, cover_offsets, start, cover_type, site_wkb) -> np.ndarray:
    """Per cover type and year: area of the site it occupies, where later
    covers take precedence over earlier ones wherever they overlap; NaN
    where a type occupies nothing (not even an empty-area sliver). Axes:
    (cover_type, time)."""
    site = _site(site_wkb)
    covers = arrays_to_geometries(cover_wkb, cover_offsets)
    type_index = cover_type.argmax(axis=1)

    def areas(active: np.ndarray) -> np.ndarray:
        by_type = np.full(cover_type.shape[1], np.nan)
        remaining = site
        for i in reversed(np.flatnonzero(active)):
            geom = covers[i].intersection(remaining)
            if geom.is_empty:
                continue
            k = type_index[i]
            by_type[k] = (0.0 if np.isnan(by_type[k]) else by_type[k]) + geom.area
            remaining = remaining.difference(geom)
        return by_type

    return _by_active_set(years, start, areas)
