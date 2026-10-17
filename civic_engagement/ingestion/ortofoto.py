"""Average roof colour from PAT's 2015 orthophoto, for tinting the 3D roof
material — nothing else in this pipeline gives us real per-building colour
(OSM has none, and the procedural facade/roof materials in the frontend are
generic). Deliberately *not* used to decide flat vs. pitched: calibrated
against orthophoto hue, saturation and local-gradient texture, none
separated the known-pitched buildings from a known-flat one with heavy
rooftop plant any better than chance — real roof-type classification from a
single top-down photo needs actual blob/texture analysis, out of scope here.
Colour alone is a much lower-stakes use: a wrong tint looks a little off, a
wrong roof shape looks structurally broken.
"""

import json
from dataclasses import dataclass

import numpy as np
from PIL import Image
from shapely.geometry.base import BaseGeometry

from civic_engagement.config import SITE
from civic_engagement.ingestion.raster import Grid, sample_polygon


@dataclass
class OrtofotoModel:
    _grid: Grid

    @classmethod
    def load(
        cls, png_path: str = SITE.ortofoto_png_path, sidecar_path: str = SITE.ortofoto_sidecar_path
    ) -> "OrtofotoModel | None":
        try:
            with open(sidecar_path) as f:
                sidecar = json.load(f)
            array = np.array(Image.open(png_path).convert("RGB"), dtype=np.float64)
        except FileNotFoundError:
            return None
        grid = Grid(
            origin_x=sidecar["origin_x"],
            origin_y=sidecar["origin_y"],
            pixel_size_x=sidecar["pixel_size_x"],
            pixel_size_y=sidecar["pixel_size_y"],
            array=array,
        )
        return cls(grid)

    def sample_roof_rgb(self, polygon_utm: BaseGeometry) -> tuple[int, int, int] | None:
        pixels = sample_polygon(polygon_utm, self._grid)
        if pixels.size == 0:
            return None
        r, g, b = np.median(pixels.reshape(-1, 3), axis=0)
        return int(r), int(g), int(b)
