"""Shared by the clearing tests: places picked from the baseline's data."""

from shapely.geometry import box

from civic_twin.domains.urban.clearing import analyse, to_wgs84
from civic_twin.domains.urban.layout import build_layout, cultivation_area
from civic_twin.geo_utils import to_projected
from civic_twin.models.schema import BaselineScene

BUSY_HALF_M = 10.0
_busy: dict[int, dict] = {}  # the search takes seconds: once per baseline object


def busy_polygon(baseline: BaselineScene) -> dict:
    """A 20 m square (GeoJSON) that blocks nothing and clears a tree, a bench
    and a path reaching beyond it, the first one found on a 5 m grid."""
    if id(baseline) in _busy:
        return _busy[id(baseline)]
    layout = build_layout(baseline, [])
    min_x, min_y, max_x, max_y = to_projected(baseline.site_boundary).bounds
    for x in range(int(min_x), int(max_x), 5):
        for y in range(int(min_y), int(max_y), 5):
            polygon = to_wgs84(box(x - BUSY_HALF_M, y - BUSY_HALF_M, x + BUSY_HALF_M, y + BUSY_HALF_M))
            report = analyse(layout, cultivation_area(polygon), 0)
            if not report.blocking and {"tree", "bench", "path"} <= report.elements_by_type.keys() and (
                report.whole_removals
            ):
                _busy[id(baseline)] = polygon
                return polygon
    raise RuntimeError("no busy spot in the baseline")
