"""The 3D view's local metric frame (frontend/src/three/geo.ts): an
equirectangular tangent plane at the mean of the site boundary's outer ring
vertices. The backend builds what the frontend draws without reprojecting
in this frame (the felt-temperature field, the terrain grid), so it must
match the frontend's to the digit.

The frontend's 3D frame has x east and z *south*; `Anchor.local` gives x
east and y *north*, as maps do. Over a few kilometres the equirectangular
scaling is within about a metre of a real projection (see geo.ts).
"""

import math
from dataclasses import dataclass

import numpy as np
import shapely
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry


@dataclass(frozen=True)
class Anchor:
    lng0: float
    lat0: float
    m_per_lng: float
    m_per_lat: float

    @classmethod
    def of(cls, boundary: dict) -> "Anchor":
        """As the frontend's `anchorFromPolygon`: the mean of the outer
        ring's vertices (closing vertex included)."""
        ring = boundary["coordinates"][0]
        lng0 = sum(p[0] for p in ring) / len(ring)
        lat0 = sum(p[1] for p in ring) / len(ring)
        phi = math.radians(lat0)
        return cls(
            lng0=lng0,
            lat0=lat0,
            m_per_lat=111132.92 - 559.82 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi),
            m_per_lng=111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi),
        )

    def local(self, geojson: dict) -> BaseGeometry:
        """A GeoJSON geometry in metres east/north of the anchor."""
        return shapely.transform(
            shape(geojson),
            lambda c: np.column_stack(((c[:, 0] - self.lng0) * self.m_per_lng, (c[:, 1] - self.lat0) * self.m_per_lat)),
        )

    def lng_lat(self, x: np.ndarray, north: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Longitudes and latitudes of points `x` metres east and `north`
        metres north of the anchor."""
        return self.lng0 + x / self.m_per_lng, self.lat0 + north / self.m_per_lat
