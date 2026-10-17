"""The urban pack's sites: the generic site fields (civic_engagement/
config.py's SiteConfig) plus what the urban ingestion and model need.

`SITE` is the active site (the core's), typed as an urban one.
"""

from dataclasses import dataclass, field
from typing import cast

from civic_engagement.config import SITE as _SITE
from civic_engagement.config import SiteConfig


@dataclass(frozen=True, kw_only=True)
class UrbanSiteConfig(SiteConfig):
    # Buildings adjacent to the square (e.g. a train station) are fetched
    # with a small buffer around the site boundary so they render even if
    # their footprint centroid falls just outside it.
    building_fetch_buffer_m: float
    default_building_height_m: float
    # Storey height used to turn OSM `building:levels` into metres, when
    # there's no explicit `height` tag.
    building_level_height_m: float
    # Last-resort heights keyed on the OSM `building` value, for footprints
    # carrying neither `height` nor `building:levels`.
    building_kind_default_height_m: dict = field(default_factory=dict)

    # Above this, a building's LiDAR nDSM (surface-minus-terrain height)
    # varies too much across its own footprint to be a flat roof — see
    # ingestion/lidar.py.
    roof_pitch_std_threshold_m: float = 2.0
    # A pitched roof's rise (ridge above eave) is clamped to this range
    # rather than trusted at face value — see ingestion/build_baseline.py.
    roof_min_rise_m: float = 1.5
    roof_max_rise_m: float = 6.0

    # How "plant_grove" (and any future area-planting card) scatters its
    # trees within the drawn polygon — see layout.py and geo_utils.grove_points_within.
    #   "grid":     a plain regular grid. Predictable, but reads as
    #               mechanical rows and columns rather than a planted grove.
    #   "jittered": the same grid, each point nudged by a small seeded
    #               random offset so it doesn't look aligned. Default.
    grove_placement_algorithm: str = "jittered"

    # Crossing stripes and lane lines are inferred from OSM tags — reliable
    # where streets are cleanly mapped (Trento), noticeably messier on
    # Bologna's bus forecourt. Applied when the scene is served (see
    # pack.py), so switching it only needs a backend restart, not a
    # baseline rebuild.
    show_road_markings: bool = True


_TRENTO_BUILDING_KIND_DEFAULT_HEIGHT_M = {
    "church": 18.0,
    "apartments": 15.0,
    "public": 14.0,
    "office": 14.0,
    "hotel": 14.0,
    "train_station": 12.0,
    "residential": 12.0,
    "commercial": 12.0,
    "transportation": 8.0,
    "retail": 8.0,
    "parking": 6.0,
    "roof": 4.0,
    "service": 4.0,
    "garage": 3.0,
    "garages": 3.0,
    "shed": 3.0,
    "hut": 3.0,
    "kiosk": 3.0,
}

SITES: dict[str, SiteConfig] = {
    "piazza_dante": UrbanSiteConfig(
        site_id="piazza_dante",
        # Shown as a square in an imaginary city, Utopia; the data (OSM,
        # LiDAR, orthophoto, climate) are those of Piazza Dante in Trento.
        name="Piazza Dante, Utopia",
        # Fetched via osmnx.geocode_to_gdf("Piazza Dante, Trento, Italy") —
        # the OSM-tagged boundary of the square itself, not a radius circle,
        # so site-area indicators have a well-defined denominator.
        site_boundary_geojson={
            "type": "Polygon",
            "coordinates": [[
                [11.1192155, 46.0717873], [11.1193217, 46.0717107], [11.1193255, 46.0714685],
                [11.1193789, 46.0714727], [11.1193807, 46.0714505], [11.1193832, 46.0714256],
                [11.1194692, 46.0710886], [11.1193726, 46.0710467], [11.1193145, 46.0710441],
                [11.1193165, 46.0710186], [11.1193168, 46.0709877], [11.1193173, 46.0709786],
                [11.1193979, 46.0709795], [11.1194, 46.0709385], [11.119409, 46.0708459],
                [11.1194122, 46.0708151], [11.1194154, 46.0707855], [11.1194279, 46.0706032],
                [11.1194288, 46.0705773], [11.1195074, 46.0704667], [11.1195693, 46.0703366],
                [11.1195915, 46.070166], [11.1198093, 46.0700216], [11.1200007, 46.0700446],
                [11.1200739, 46.0700497], [11.120304, 46.0700751], [11.1206617, 46.0701146],
                [11.1207697, 46.0701265], [11.1209982, 46.0701541], [11.121169, 46.0701719],
                [11.1214808, 46.0701972], [11.1216255, 46.0702236], [11.1216175, 46.0702508],
                [11.1216846, 46.0702651], [11.1216325, 46.0704496], [11.1216112, 46.0705114],
                [11.1215915, 46.0705688], [11.1215717, 46.0706262], [11.1215663, 46.0706486],
                [11.1215639, 46.0706585], [11.1217522, 46.0707653], [11.1216879, 46.0709373],
                [11.1216647, 46.0709496], [11.1216302, 46.070968], [11.1214871, 46.0709483],
                [11.1214304, 46.0711478], [11.1214159, 46.0711444], [11.1213955, 46.0712455],
                [11.1213872, 46.0713054], [11.1215918, 46.0718965], [11.1216578, 46.072052],
                [11.1215109, 46.0721084], [11.1213314, 46.0721632], [11.1212361, 46.0721923],
                [11.1209658, 46.0722763], [11.1209469, 46.0722825], [11.1206557, 46.0723776],
                [11.1206341, 46.0723846], [11.1202994, 46.0724968], [11.1202564, 46.0725046],
                [11.1200754, 46.0724761], [11.1196427, 46.0724089], [11.1194179, 46.0720818],
                [11.1192155, 46.0717873],
            ]],
        },
        boundary_status="surveyed",
        building_fetch_buffer_m=60,
        default_building_height_m=10.0,
        building_level_height_m=3.2,
        building_kind_default_height_m=_TRENTO_BUILDING_KIND_DEFAULT_HEIGHT_M,
        roof_pitch_std_threshold_m=2.0,
        roof_min_rise_m=1.5,
        roof_max_rise_m=6.0,
        grove_placement_algorithm="jittered",
        data_dir="data/piazza_dante",
    ),
    "piazza_xx_settembre": UrbanSiteConfig(
        site_id="piazza_xx_settembre",
        name="Piazza XX Settembre, Bologna",
        # PROVISIONAL — unlike Piazza Dante, this square has no OSM polygon
        # to fetch (only road segments/bus-stop nodes carry the name, plus a
        # place=square *point*). This is a plain ~45m-radius circle around
        # the square's approximate centroid near Bologna Centrale station,
        # sized (checked against the surrounding OSM building layout) to sit
        # over open ground rather than through a building — but it is not
        # real digitized data and site-area indicators here are only as
        # good as this placeholder. Replace once the square is properly
        # traced against real imagery (LiDAR/orthophoto/oblique photos are
        # expected to arrive for this site — see boundary_status below).
        site_boundary_geojson={
            "type": "Polygon",
            "coordinates": [[
                [11.3448656, 44.5043884], [11.3448633, 44.5043619], [11.3448587, 44.5043356],
                [11.3448516, 44.5043096], [11.3448421, 44.504284], [11.3448304, 44.5042589],
                [11.3448164, 44.5042344], [11.3448001, 44.5042106], [11.3447817, 44.5041875],
                [11.3447613, 44.5041655], [11.3447389, 44.5041444], [11.3447146, 44.5041244],
                [11.3446885, 44.5041056], [11.3446607, 44.504088], [11.3446314, 44.5040718],
                [11.3446007, 44.504057], [11.3445688, 44.5040436], [11.3445356, 44.5040318],
                [11.3445015, 44.5040216], [11.3444664, 44.504013], [11.3444307, 44.504006],
                [11.3443944, 44.5040007], [11.3443577, 44.5039972], [11.3443208, 44.5039953],
                [11.3442838, 44.5039952], [11.3442468, 44.5039968], [11.3442101, 44.5040002],
                [11.3441737, 44.5040053], [11.3441379, 44.504012], [11.3441028, 44.5040204],
                [11.3440686, 44.5040305], [11.3440353, 44.5040421], [11.3440031, 44.5040553],
                [11.3439723, 44.5040699], [11.3439428, 44.5040859], [11.3439149, 44.5041033],
                [11.3438886, 44.504122], [11.343864, 44.5041418], [11.3438414, 44.5041628],
                [11.3438207, 44.5041848], [11.343802, 44.5042077], [11.3437855, 44.5042314],
                [11.3437712, 44.5042558], [11.3437592, 44.5042809], [11.3437495, 44.5043065],
                [11.3437421, 44.5043324], [11.3437371, 44.5043587], [11.3437345, 44.5043851],
                [11.3437344, 44.5044116], [11.3437367, 44.5044381], [11.3437413, 44.5044643],
                [11.3437484, 44.5044904], [11.3437579, 44.504516], [11.3437696, 44.5045411],
                [11.3437836, 44.5045656], [11.3437999, 44.5045894], [11.3438183, 44.5046124],
                [11.3438387, 44.5046345], [11.3438611, 44.5046556], [11.3438854, 44.5046756],
                [11.3439115, 44.5046944], [11.3439393, 44.504712], [11.3439685, 44.5047282],
                [11.3439993, 44.504743], [11.3440312, 44.5047564], [11.3440644, 44.5047682],
                [11.3440985, 44.5047784], [11.3441336, 44.504787], [11.3441693, 44.504794],
                [11.3442056, 44.5047993], [11.3442423, 44.5048028], [11.3442792, 44.5048047],
                [11.3443162, 44.5048048], [11.3443532, 44.5048032], [11.3443899, 44.5047998],
                [11.3444263, 44.5047947], [11.3444621, 44.504788], [11.3444972, 44.5047796],
                [11.3445315, 44.5047695], [11.3445647, 44.5047579], [11.3445969, 44.5047447],
                [11.3446277, 44.5047301], [11.3446572, 44.5047141], [11.3446851, 44.5046967],
                [11.3447114, 44.504678], [11.344736, 44.5046582], [11.3447586, 44.5046372],
                [11.3447793, 44.5046152], [11.344798, 44.5045923], [11.3448145, 44.5045686],
                [11.3448288, 44.5045442], [11.3448408, 44.5045191], [11.3448506, 44.5044935],
                [11.3448579, 44.5044676], [11.3448629, 44.5044413], [11.3448655, 44.5044149],
                [11.3448656, 44.5043884],
            ]],
        },
        boundary_status="provisional",
        # Wider than Trento's 60m: the provisional boundary circle is tight
        # against the station forecourt, and the facilitator wants more of
        # the surrounding context (buildings/trees/streetlights, especially
        # east/north-east toward the station) actually fetched and rendered,
        # even though the site-boundary polygon itself (and its area-based
        # indicators) stays unchanged — see fetch_area vs. site_polygon in
        # ingestion/build_baseline.py.
        building_fetch_buffer_m=150,
        # Everything else below is reused unchanged from Trento — no evidence
        # yet Bologna needs different heuristics; revisit once real
        # LiDAR/orthophoto data (or a session or two of real use) says
        # otherwise.
        default_building_height_m=10.0,
        building_level_height_m=3.2,
        building_kind_default_height_m=_TRENTO_BUILDING_KIND_DEFAULT_HEIGHT_M,
        roof_pitch_std_threshold_m=2.0,
        roof_min_rise_m=1.5,
        roof_max_rise_m=6.0,
        grove_placement_algorithm="jittered",
        # Set to False to hide the OSM-inferred crossing stripes/lane lines
        # (e.g. for a demo) until real imagery replaces them.
        show_road_markings=True,
        data_dir="data/piazza_xx_settembre",
    ),
}

DEFAULT_SITE = "piazza_dante"

SITE = cast(UrbanSiteConfig, _SITE)
