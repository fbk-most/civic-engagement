"""What stands where: two things cannot stand on the same ground.

Every card has a *footprint*, the ground it takes, and `blocking_occupants`
says what already stands on the footprint of a card about to be placed. It
only *looks*, like `clearing.analyse`, and the check shown to the user and
the refusal of the placement both come from it.

In short (the tables are in `parameters.py`):

- an object (a point, a path) is refused over any other object, over a
  card's area (a garden, a grove, a playground, a fitness area) and over water;
  two paths may cross;
- an area card is refused over the same things: it does not clear them, except
  "coltiva il terreno", which clears objects (see clearing.py) and is only
  refused over another card's area;
- a card that only changes the ground cover has no footprint;
- what is looked at is what stands in the year of the card or later: a card
  placed for year 3 must not end up under something placed for year 10.

Everything is measured in the projected CRS, in metres.
"""

from shapely.geometry.base import BaseGeometry

from civic_twin.domains.urban.clearing import (
    AREAS,
    DEFAULT_MARKING_WIDTH_M,
    DEFAULT_STREET_WIDTH_M,
    LINES,
    MIN_OVERLAP_M2,
    kind_and_geometry,
    owner,
    project,
)
from civic_twin.domains.urban.layout import Layout, cultivation_area
from civic_twin.domains.urban.parameters import (
    CROSSABLE_ELEMENT_TYPES,
    DEFAULT_FOOTPRINT_RADIUS_M,
    DEFAULT_PATH_WIDTH_M,
    FOOTPRINT_RADIUS_M,
    OCCUPYING_AREA_CARDS,
    PERGOLA_FOOTPRINT_RADIUS_M,
    PROTECTED_COVER_TYPES,
)
from civic_twin.geo_utils import to_projected

# What a card that places one object is: the type of that object.
OBJECT_OF_CARD = {
    "plant_tree": "tree",
    "add_bench": "bench",
    "add_streetlight": "streetlight",
    "add_kiosk": "kiosk",
    "add_pergola": "pergola",
    "new_path": "path",
}


def _line_width(element_type: str, properties: dict) -> float:
    default = {"street": DEFAULT_STREET_WIDTH_M, "path": DEFAULT_PATH_WIDTH_M}.get(
        element_type, DEFAULT_MARKING_WIDTH_M
    )
    return float(properties.get("width") or default)


def _point_radius(element_type: str, properties: dict) -> float:
    if element_type == "pergola":
        return PERGOLA_FOOTPRINT_RADIUS_M[properties.get("size", "medium")]
    return FOOTPRINT_RADIUS_M.get(element_type, DEFAULT_FOOTPRINT_RADIUS_M)


def _object_footprint(element_type: str, properties: dict, geometry: BaseGeometry) -> BaseGeometry:
    if geometry.geom_type in LINES:
        return geometry.buffer(_line_width(element_type, properties) / 2)
    if geometry.geom_type in AREAS:
        return geometry
    return geometry.buffer(_point_radius(element_type, properties))


def footprint(card_type: str, geometry: dict, params: dict) -> BaseGeometry | None:
    """The ground a card would take (projected), None for a card that takes none."""
    if card_type == "cultivate_terrain":
        return to_projected(cultivation_area(geometry))
    if card_type in OCCUPYING_AREA_CARDS:
        return to_projected(geometry)
    if card_type in OBJECT_OF_CARD:
        element_type = OBJECT_OF_CARD[card_type]
        properties = (
            {"width": params.get("width")} if element_type == "path" else {"size": params.get("size", "medium")}
        )
        return _object_footprint(element_type, properties, to_projected(geometry))
    return None


def _overlaps(a: BaseGeometry, b: BaseGeometry) -> bool:
    """Whether two footprints are one on the other, not just touching: the
    overlap has to be more than a sliver (as much as `MIN_OVERLAP_M2`, or a
    quarter of the smaller one when that is a small object)."""
    if not a.intersects(b):
        return False
    return a.intersection(b).area > min(MIN_OVERLAP_M2, 0.25 * min(a.area, b.area))


def blocking_occupants(
    layout: Layout,
    card_type: str,
    geometry: dict,
    params: dict,
    year: int,
    *,
    own_id: str | None = None,
    replaces_element_id: str | None = None,
) -> list[tuple[str, str]]:
    """What stands on the ground the card would take, as (id, type) pairs.

    `own_id` is the card itself, when it is already placed (it is being edited);
    `replaces_element_id` the tree a replanting takes the place of."""
    mine = footprint(card_type, geometry, params)
    if mine is None:
        return []
    only_areas = card_type == "cultivate_terrain"
    own_object = OBJECT_OF_CARD.get(card_type)

    # The footprints of everything that stands there: (id, type, ground).
    standing: list[tuple[str, str, BaseGeometry]] = []
    for iv in layout.interventions:
        if iv.card_type in OCCUPYING_AREA_CARDS and iv.id != own_id:
            ground = footprint(iv.card_type, iv.geometry, iv.params)
            standing.append((iv.id, OCCUPYING_AREA_CARDS[iv.card_type], ground))
    if not only_areas:
        entries = []
        for entry in layout.entries:
            if entry.end is not None and entry.end <= year:
                continue  # gone before this card
            if owner(layout, entry) == own_id and own_id is not None:
                continue
            kind, geom = kind_and_geometry(layout, entry)
            if entry.tree is not None:
                slot = layout.trees[entry.tree]
                if slot.origin == "grove" or slot.element_id == replaces_element_id:
                    continue  # a grove's trees are in its area; a replanting replaces its tree
            if entry.cover is not None:
                if entry.cover.cover_type not in PROTECTED_COVER_TYPES:
                    continue
                kind = entry.cover.cover_type
            elif kind in ("playground", "fitness_area"):
                continue  # in the area of their card
            if own_object is not None and own_object in CROSSABLE_ELEMENT_TYPES and kind == own_object:
                continue
            entries.append((entry, kind, geom))
        grounds = project([geom for _, _, geom in entries])
        for (entry, kind, _), ground in zip(entries, grounds, strict=True):
            properties = entry.element.properties if entry.element is not None else {}
            if entry.cover is None:
                ground = _object_footprint(kind, properties, ground)
            ident = (
                entry.element.id if entry.element is not None
                else entry.cover.id if entry.cover is not None
                else layout.trees[entry.tree].element_id
            )
            standing.append((ident, kind, ground))
    return [(ident, kind) for ident, kind, ground in standing if _overlaps(mine, ground)]
