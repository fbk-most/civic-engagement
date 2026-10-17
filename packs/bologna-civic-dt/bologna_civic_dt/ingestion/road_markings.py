"""Generator for road-surface paint markings — pedestrian-crossing zebra
stripes and lane-divider dashes — as sequences of short line segments. Both
are the same shape of problem (short bars/dashes spaced along a line), so
they share `dashed_segments` rather than getting one generator each; see
build_baseline.py for how each marking type's source line is built and fed
through it.
"""

import math

from shapely.geometry import LineString, MultiLineString
from shapely.geometry.base import BaseGeometry

from bologna_civic_dt.ingestion.osm import LANE_WIDTH_M

# PoC-level constants, same spirit as osm.py's DEFAULT_WIDTH_M/
# PATH_WIDTH_DEFAULTS_M: a per-crossing "which street am I crossing, how wide
# is it" lookup was considered and dropped — matching a crossing to *the*
# street it crosses isn't always a clean 1:1 relationship near a complex
# junction — so every crossing gets the same fixed stripe geometry instead.
CROSSING_STRIPE_WIDTH_M = 0.5
CROSSING_STRIPE_DASH_M = 0.5
CROSSING_STRIPE_GAP_M = 0.5
CROSSING_STRIPE_LEN_M = 5.0

LANE_DIVIDER_WIDTH_M = 0.12
LANE_DIVIDER_DASH_M = 1.0
LANE_DIVIDER_GAP_M = 1.0


def _tangent_at(line: LineString, distance: float, eps: float = 0.1) -> tuple[float, float]:
    """Local unit tangent of `line` at arc-length `distance`, via a small
    central difference — cheap and accurate enough at this scale, and robust
    to `distance` landing exactly on a vertex (unlike differencing the two
    surrounding vertices directly)."""
    d0 = max(distance - eps, 0.0)
    d1 = min(distance + eps, line.length)
    p0, p1 = line.interpolate(d0), line.interpolate(d1)
    dx, dy = p1.x - p0.x, p1.y - p0.y
    length = math.hypot(dx, dy)
    return (dx / length, dy / length) if length else (1.0, 0.0)


def dashed_segments(
    line: LineString, dash_len_m: float, gap_len_m: float, perpendicular_len_m: float | None = None
) -> list[LineString]:
    """Slices `line` into evenly-spaced short segments. With
    perpendicular_len_m set, each output segment is a bar of that length,
    centred on the sample point, oriented perpendicular to line's local
    tangent there (crossing stripes — the bar spans the road). Without it,
    each output segment just follows line's own direction (a plain dash —
    a lane divider running along the street)."""
    period = dash_len_m + gap_len_m
    length = line.length
    if length <= 0:
        return []

    segments: list[LineString] = []
    distance = dash_len_m / 2
    while distance <= length:
        point = line.interpolate(distance)
        tx, ty = _tangent_at(line, distance)
        if perpendicular_len_m is not None:
            dx, dy, half = -ty, tx, perpendicular_len_m / 2
        else:
            dx, dy, half = tx, ty, dash_len_m / 2
        segments.append(
            LineString([(point.x - dx * half, point.y - dy * half), (point.x + dx * half, point.y + dy * half)])
        )
        distance += period

    return segments


# Two-way streets with no `lanes` tag still get a centreline (assumed one lane
# each way) on these classes — but not on `service` ways (alleys, parking
# aisles, bus-station access), which in practice carry no centre marking.
CENTRELINE_DEFAULT_CLASSES = {"primary", "secondary", "tertiary", "unclassified", "residential"}


def as_lines(geom: BaseGeometry) -> list[LineString]:
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, MultiLineString):
        return list(geom.geoms)
    return []


def lane_marking_lines(
    line: BaseGeometry,
    lanes: float | None,
    oneway: bool,
    lanes_forward: float | None,
    lanes_backward: float | None,
    highway: str | None,
) -> tuple[list[LineString], list[LineString]]:
    """Lane-boundary lines for one street way, as (solid, dashed): a solid
    line where traffic directions meet, dashed between lanes of the same
    direction. Lanes are laid out `LANE_WIDTH_M` apart, centred on the way's
    own centreline — the same width `osm.street_widths` gives a way from its
    `lanes` tag. For a two-way way, backward lanes sit on the left of the
    digitized direction (right-hand traffic), so the solid direction boundary
    lands `lanes_backward` lanes in from the left edge.

    Divided roads mapped as two separate oneway ways get their solid
    separating line from the pair's midline instead (see build_baseline.py),
    not from here — each way on its own only ever knows about its own
    direction.
    """
    n = int(lanes) if lanes and lanes > 0 else None
    if n is None:
        if oneway or highway not in CENTRELINE_DEFAULT_CLASSES:
            return [], []
        n = 2
    if n < 2:
        return [], []

    solid_k: int | None = None
    if not oneway:
        if lanes_backward and 0 < lanes_backward < n:
            solid_k = int(lanes_backward)
        elif lanes_forward and 0 < lanes_forward < n:
            solid_k = n - int(lanes_forward)
        else:
            solid_k = n // 2

    half_width = n * LANE_WIDTH_M / 2
    solid: list[LineString] = []
    dashed: list[LineString] = []
    for base in as_lines(line):
        for k in range(1, n):
            # offset_curve: positive distance is to the left of the line's
            # digitized direction.
            offset = half_width - k * LANE_WIDTH_M
            shifted = as_lines(base.offset_curve(offset)) if offset else [base]
            (solid if k == solid_k else dashed).extend(shifted)
    return solid, dashed
