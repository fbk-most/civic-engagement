"""TEMPORARY — records what the backend serves today, so that restructuring
the model can be checked against it ("same numbers", see the README). Remove together with
tests/fixtures/reference/ once that reference is no longer needed.

One site per process, since the active site is fixed at import time
(`CIVIC_ENGAGEMENT_SITE`, see civic_engagement/config.py):

    CIVIC_ENGAGEMENT_SITE=piazza_dante uv run python packs/bologna-civic-dt/tests/reference/capture.py
    CIVIC_ENGAGEMENT_SITE=piazza_dante uv run python packs/bologna-civic-dt/tests/reference/capture.py --out /tmp/x

Sessions recorded per site:
- `empty`: no interventions;
- `saved`: the site's session.json as it was when the reference was first
  recorded — frozen into the fixtures, since session.json itself is live,
  gitignored workshop state;
- `synthetic`: every card type, cards placed at later years, overlapping
  covers, and the replant of a baseline tree cut within the horizon.
"""

import argparse
import gzip
import hashlib
import json
from pathlib import Path

from shapely.geometry import LineString, Point, box, mapping

from bologna_civic_dt.pack import UrbanPack
from civic_engagement.domain import register

# Before the core's scene and store, which read the pack when imported.
register(UrbanPack())

from civic_engagement import scene  # noqa: E402
from civic_engagement.config import SITE  # noqa: E402
from civic_engagement.geo_utils import to_projected  # noqa: E402
from civic_engagement.models.schema import Intervention  # noqa: E402
from civic_engagement.scene import MAX_T, MIN_T, current_scene, deferred_indicators, indicator_series, load_baseline  # noqa: E402

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "reference"
CREATED_AT = "2026-09-30T00:00:00+00:00"


def _to_wgs84(geom) -> dict:
    import geopandas as gpd

    from civic_engagement.config import PROJECTED_CRS, WGS84_CRS

    return mapping(gpd.GeoSeries([geom], crs=PROJECTED_CRS).to_crs(WGS84_CRS).iloc[0])


def _synthetic_session() -> list[dict]:
    """Card placements laid out on a small grid around a point well inside
    the site, so the same recipe works on both sites' boundaries."""
    site = to_projected(load_baseline().site_boundary)
    c = site.representative_point()

    def at(dx: float, dy: float) -> Point:
        point = Point(c.x + dx, c.y + dy)
        assert site.contains(point), f"synthetic placement {dx},{dy} falls outside the site"
        return point

    def square(dx: float, dy: float, size: float):
        return box(c.x + dx, c.y + dy, c.x + dx + size, c.y + dy + size)

    cut_tree = min(
        (e for e in load_baseline().elements if e.type == "tree" and e.properties.get("cut_year") is not None),
        key=lambda e: e.properties["cut_year"],
    )
    cut_year = cut_tree.properties["cut_year"]

    # (card type, geometry in projected metres, params, planted year, replaced element)
    cards = [
        ("plant_tree", at(0, 0), {"species": "oak", "canopy_diameter": 1.0}, 0, None),
        ("plant_tree", at(3, 0), {"species": "cypress", "canopy_diameter": 2.0}, 12, None),
        ("new_path", LineString([at(-10, -2), at(10, -2)]), {"width": 2.0, "material": "gravel"}, 0, None),
        ("new_path", LineString([at(-10, 2), at(-2, 8)]), {"width": 1.5, "material": "wood"}, 5, None),
        # The two covers overlap, and the later one overlaps the grove too.
        ("change_ground_cover", square(-12, -12, 8), {"cover_type": "meadow"}, 0, None),
        ("change_ground_cover", square(-8, -8, 12), {"cover_type": "permeable_paving"}, 8, None),
        ("plant_grove", square(2, -12, 9), {"species": "birch", "spacing": 4.0}, 3, None),
        ("add_streetlight", at(-4, 4), {}, 0, None),
        ("add_streetlight", at(6, 6), {}, 20, None),
        ("add_bench", at(-6, 0), {}, 0, None),
        ("add_pergola", at(8, 0), {"size": "large"}, 0, None),
        ("add_pergola", at(-8, 6), {"size": "small"}, 10, None),
        ("add_kiosk", at(0, 8), {}, 15, None),
        ("add_playground", square(4, 2, 7), {"age_range": "mixed"}, 0, None),
        ("add_fitness_area", square(-14, 0, 6), {"target_age": "teens"}, 25, None),
    ]
    interventions = [
        Intervention(
            id=f"int-synthetic-{i:02d}",
            card_type=card_type,
            geometry=_to_wgs84(geometry),
            params=params,
            created_at=CREATED_AT,
            replaces_element_id=replaces,
            planted_year=planted_year,
        )
        for i, (card_type, geometry, params, planted_year, replaces) in enumerate(cards)
    ]
    # Replanting a baseline tree after it is cut: its geometry is the baseline
    # tree's own WGS84 point, not a synthetic placement.
    interventions.append(
        Intervention(
            id=f"int-synthetic-{len(cards):02d}",
            card_type="plant_tree",
            geometry=cut_tree.geometry,
            params={"species": "linden", "canopy_diameter": 1.5},
            created_at=CREATED_AT,
            replaces_element_id=cut_tree.id,
            planted_year=min(cut_year + 2, MAX_T),
        )
    )
    return [i.model_dump(mode="json") for i in interventions]


def _sessions(site_dir: Path) -> dict[str, list[Intervention]]:
    saved_path = site_dir / "saved_session.json"
    if not saved_path.exists():
        live = Path(SITE.session_json_path)
        saved = json.loads(live.read_text()).get("default", []) if live.exists() else []
        saved_path.write_text(json.dumps(saved, indent=1))
    synthetic_path = site_dir / "synthetic_session.json"
    if not synthetic_path.exists():
        synthetic_path.write_text(json.dumps(_synthetic_session(), indent=1))

    def load(path: Path) -> list[Intervention]:
        return [Intervention(**i) for i in json.loads(path.read_text()) if not i.get("deleted")]

    sessions = {"empty": [], "saved": load(saved_path), "synthetic": load(synthetic_path)}
    # A site with no saved session would only duplicate `empty`.
    return {name: interventions for name, interventions in sessions.items() if name == "empty" or interventions}


def _canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def capture(interventions: list[Intervention]) -> dict:
    scene.store.list_interventions = lambda session_id="default": list(interventions)
    scene._scenario_cache.clear()

    years = []
    for t in range(MIN_T, MAX_T + 1):
        # The revision depends on the backend's boot, not on the model; the
        # site's name is only for the window title.
        response = current_scene(t).model_dump(mode="json", exclude={"revision", "site_name"})
        # Served apart since the scene stopped waiting for them: put back
        # where they were recorded, so the same numbers are compared.
        deferred = deferred_indicators(t).model_dump(mode="json")
        response["indicators"].update(deferred["scenario"])
        response["baseline_indicators"].update(deferred["baseline"])
        years.append({
            "t": t,
            "indicators": response["indicators"],
            "baseline_indicators": response["baseline_indicators"],
            "trees": [e for e in response["elements"] if e["type"] == "tree"],
            "scene_sha256": hashlib.sha256(_canonical(response).encode()).hexdigest(),
        })
    return {"years": years, "series": indicator_series().model_dump(mode="json")}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=FIXTURES, help="where to write <site>/<session>.json.gz")
    args = parser.parse_args()

    site_fixtures = FIXTURES / SITE.site_id
    site_fixtures.mkdir(parents=True, exist_ok=True)
    out_dir = args.out / SITE.site_id
    out_dir.mkdir(parents=True, exist_ok=True)

    for name, interventions in _sessions(site_fixtures).items():
        # mtime=0: the same content always gives the same bytes, so an
        # unchanged reference doesn't show up as modified in git.
        with gzip.GzipFile(out_dir / f"{name}.json.gz", "wb", mtime=0) as f:
            f.write(_canonical(capture(interventions)).encode())
        print(f"{SITE.site_id}/{name}: {len(interventions)} interventions")


if __name__ == "__main__":
    main()
