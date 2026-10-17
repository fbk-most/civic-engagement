"""A scenario's layout as the urban model's per-scenario inputs: one array
per input of `model.SCENARIO_INPUT_AXES`, one entry per tree, path, cost
item, cover, lamp, shelter and card — each with the year it appears from.

Only plain measurements are taken here (lengths, areas, projected
coordinates); everything that combines them is the model's.
"""

import geopandas as gpd
import numpy as np
from shapely.geometry import Polygon, shape

from civic_engagement.config import PROJECTED_CRS, WGS84_CRS
from bologna_civic_dt import cdt_compat
from bologna_civic_dt.layout import Layout
from bologna_civic_dt.model import (
    AGE_CLASSES,
    COVER_TYPES,
    INCLUSION_CARDS,
    INCLUSION_GROUPS,
    MATERIALS,
    OTHER_MATERIAL,
    PRICE_KEYS,
    PRICES,
    SHELTER_KINDS,
    SPECIES_KEYS,
)
from bologna_civic_dt.parameters import COST_PER_PERGOLA_EUR, COST_PER_TREE_EUR
from civic_engagement.geo_utils import area_m2, length_m, to_projected

NEVER = np.inf  # a start year no scenario year reaches: the sentinel's


def _onehot(keys: list[str], key: str) -> np.ndarray:
    row = np.zeros(len(keys))
    row[keys.index(key)] = 1.0
    return row


def _project_points(geometries: list[dict]) -> tuple[list[float], list[float]]:
    if not geometries:
        return [], []
    points = gpd.GeoSeries([shape(g) for g in geometries], crs=WGS84_CRS).to_crs(PROJECTED_CRS)
    return list(points.x), list(points.y)


def _trees(layout: Layout) -> dict[str, np.ndarray]:
    rows = []
    for slot in layout.trees:
        species = slot.species if slot.species in SPECIES_KEYS else "unknown"
        baseline = slot.origin == "baseline"
        cut = slot.cut_year if slot.cut_year is not None else NEVER
        replanted = slot.cut_year is not None and slot.replant_year is not None
        end = max(slot.cut_year, slot.replant_year) if replanted else NEVER
        rows.append((
            _onehot(SPECIES_KEYS, species),
            _onehot(AGE_CLASSES, slot.age_class) if baseline else np.zeros(len(AGE_CLASSES)),
            slot.initial_diameter,
            0.0 if baseline else 1.0,
            1.0 if baseline and slot.age_class in ("mature", "veteran") else 0.0,
            slot.start,
            cut,
            end,
        ))
    sentinel = (_onehot(SPECIES_KEYS, "unknown"), np.zeros(len(AGE_CLASSES)), 0.0, 1.0, 0.0, NEVER, NEVER, NEVER)
    names = [
        "tree_species", "tree_age_class", "tree_initial_diameter", "tree_planted", "tree_fixed_size",
        "tree_start", "tree_cut", "tree_end",
    ]
    return {name: cdt_compat.with_sentinel([r[k] for r in rows], sentinel[k]) for k, name in enumerate(names)}


def _elements(layout: Layout, element_type: str) -> list:
    return [e for e in layout.entries if e.element is not None and e.element.type == element_type]


def _paths(layout: Layout) -> dict[str, np.ndarray]:
    entries = _elements(layout, "path")
    materials = []
    for entry in entries:
        material = entry.element.properties.get("material", "paving")
        materials.append(material if material in MATERIALS else OTHER_MATERIAL)
    return {
        "path_length": cdt_compat.with_sentinel([length_m(e.element.geometry) for e in entries], 0.0),
        "path_material": cdt_compat.with_sentinel(
            [_onehot(MATERIALS, m) for m in materials], np.zeros(len(MATERIALS))
        ),
        "path_start": cdt_compat.with_sentinel([e.start for e in entries], NEVER),
    }


def _cost_items(layout: Layout) -> dict[str, np.ndarray]:
    items: list[tuple[float, str, int]] = []
    card_trees: dict[str, int] = {}
    for slot in layout.trees:
        if slot.origin in ("grove", "row"):
            card_trees[slot.intervention_id] = card_trees.get(slot.intervention_id, 0) + 1
    # A lit path's lamps are counted per path, like a grove's trees.
    lamps: dict[str, int] = {}
    for entry in _elements(layout, "streetlight"):
        if entry.element.intervention_id is not None:
            lamps[entry.element.intervention_id] = lamps.get(entry.element.intervention_id, 0) + 1

    def tree_key(species: str) -> str:
        return f"tree:{species if species in COST_PER_TREE_EUR else 'unknown'}"

    def keyed(kind: str, name: str) -> str:
        key = f"{kind}:{name}"
        return key if key in PRICES else f"{kind}:other"

    for iv in layout.interventions:
        start, params, card = iv.planted_year, iv.params, iv.card_type
        if card == "plant_tree":
            items.append((1.0, tree_key(params.get("species", "unknown")), start))
        elif card == "new_path":
            quantity = length_m(iv.geometry) * params.get("width", 2.0)
            items.append((quantity, keyed("path", params.get("material", "gravel")), start))
        elif card == "change_ground_cover":
            items.append((area_m2(iv.geometry), keyed("cover", params.get("cover_type", "meadow")), start))
        elif card == "plant_grove":
            items.append((area_m2(iv.geometry), "cover:lawn", start))
            items.append((float(card_trees.get(iv.id, 0)), tree_key(params.get("species", "unknown")), start))
        elif card == "plant_tree_row":
            items.append((float(card_trees.get(iv.id, 0)), tree_key(params.get("species", "unknown")), start))
        elif card in ("add_streetlight", "add_bench", "add_kiosk"):
            items.append((1.0, f"element:{card.removeprefix('add_')}", start))
        elif card == "add_streetlight_path":
            items.append((float(lamps.get(iv.id, 0)), "element:streetlight", start))
        elif card == "add_pergola":
            size = params.get("size", "medium")
            items.append((1.0, f"pergola:{size if size in COST_PER_PERGOLA_EUR else 'medium'}", start))
        elif card == "add_playground":
            items.append((area_m2(iv.geometry), "cover:playground_surface", start))
        elif card == "add_fitness_area":
            items.append((area_m2(iv.geometry), "cover:sport_surface", start))

    return {
        "cost_quantity": cdt_compat.with_sentinel([q for q, _, _ in items], 0.0),
        "cost_price_key": cdt_compat.with_sentinel(
            [_onehot(PRICE_KEYS, k) for _, k, _ in items], np.zeros(len(PRICE_KEYS))
        ),
        "cost_start": cdt_compat.with_sentinel([s for _, _, s in items], NEVER),
    }


def _covers(layout: Layout) -> dict[str, np.ndarray]:
    entries = [e for e in layout.entries if e.cover is not None]
    projected = [to_projected(e.cover.geometry) for e in entries]
    wkb, offsets = cdt_compat.geometries_to_arrays([*projected, Polygon()])
    return {
        "cover_type": cdt_compat.with_sentinel(
            [_onehot(COVER_TYPES, e.cover.cover_type) for e in entries], np.zeros(len(COVER_TYPES))
        ),
        "cover_start": cdt_compat.with_sentinel([e.start for e in entries], NEVER),
        "cover_wkb": wkb,
        "cover_wkb_offsets": offsets,
    }


def _lamps(layout: Layout) -> dict[str, np.ndarray]:
    entries = _elements(layout, "streetlight")
    xs, ys = _project_points([e.element.geometry for e in entries])
    return {
        "lamp_x": cdt_compat.with_sentinel(xs, 0.0),
        "lamp_y": cdt_compat.with_sentinel(ys, 0.0),
        "lamp_start": cdt_compat.with_sentinel([e.start for e in entries], NEVER),
    }


def _shelters(layout: Layout) -> dict[str, np.ndarray]:
    entries = [e for e in layout.entries if e.element is not None and e.element.type in ("pergola", "kiosk")]
    kinds = []
    for entry in entries:
        if entry.element.type == "kiosk":
            kinds.append("kiosk")
        else:
            kind = f"pergola_{entry.element.properties.get('size', 'medium')}"
            kinds.append(kind if kind in SHELTER_KINDS else "pergola_medium")
    xs, ys = _project_points([e.element.geometry for e in entries])
    return {
        "shelter_x": cdt_compat.with_sentinel(xs, 0.0),
        "shelter_y": cdt_compat.with_sentinel(ys, 0.0),
        "shelter_kind": cdt_compat.with_sentinel(
            [_onehot(SHELTER_KINDS, k) for k in kinds], _onehot(SHELTER_KINDS, SHELTER_KINDS[0])
        ),
        "shelter_start": cdt_compat.with_sentinel([e.start for e in entries], NEVER),
    }


def _cards(layout: Layout) -> dict[str, np.ndarray]:
    cards = [iv for iv in layout.interventions if iv.card_type in INCLUSION_CARDS]
    return {
        "card_group": cdt_compat.with_sentinel(
            [_onehot(INCLUSION_GROUPS, INCLUSION_CARDS[iv.card_type]) for iv in cards], np.zeros(len(INCLUSION_GROUPS))
        ),
        "card_start": cdt_compat.with_sentinel([iv.planted_year for iv in cards], NEVER),
    }


def _site(layout: Layout) -> dict[str, np.ndarray | float]:
    site = to_projected(layout.site_boundary)
    wkb, _ = cdt_compat.geometries_to_arrays([site])
    return {"site_wkb": wkb, "site_area": float(site.area)}


def encode(layout: Layout) -> dict[str, np.ndarray | float]:
    return {
        **_trees(layout),
        **_paths(layout),
        **_cost_items(layout),
        **_covers(layout),
        **_lamps(layout),
        **_shelters(layout),
        **_cards(layout),
        **_site(layout),
    }
