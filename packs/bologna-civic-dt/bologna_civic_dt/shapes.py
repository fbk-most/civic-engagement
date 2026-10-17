"""Axes and named shapes of the urban model.

Shapes used in more than one place get a name (`named_shape`), so the
framework checks every `Inputs`/`Outputs`/`Expose` field annotated with one
against the actual value's axes. Shapes used once (most one-hot
encodings, the WKB arrays) stay plain `Index`, with their axes in a comment
next to the field.
"""

from civic_digital_twins.dt_model import TIME_AXIS, DomainAxis, named_shape

# --- axes -------------------------------------------------------------------

TREE = DomainAxis("tree")
SPECIES = DomainAxis("species")
AGE_CLASS = DomainAxis("age_class")
PATH = DomainAxis("path")
MATERIAL = DomainAxis("material")
COST_ITEM = DomainAxis("cost_item")
PRICE_KEY = DomainAxis("price_key")
COVER = DomainAxis("cover")
COVER_TYPE = DomainAxis("cover_type")
COVER_WKB = DomainAxis("cover_wkb")
COVER_WKB_OFFSET = DomainAxis("cover_wkb_offset")
LAMP = DomainAxis("lamp")
SHELTER = DomainAxis("shelter")
SHELTER_KIND = DomainAxis("shelter_kind")
CARD = DomainAxis("card")
INCLUSION_GROUP = DomainAxis("inclusion_group")
SITE_WKB = DomainAxis("site_wkb")
TIME = TIME_AXIS

# Every domain axis an evaluation of the model carries (see
# cdt_compat.on_axes, which needs them up front).
LAYOUT_AXES = (
    TREE, SPECIES, AGE_CLASS, PATH, MATERIAL, COST_ITEM, PRICE_KEY, COVER, COVER_TYPE,
    COVER_WKB, COVER_WKB_OFFSET, LAMP, SHELTER, SHELTER_KIND, CARD, INCLUSION_GROUP, SITE_WKB, TIME,
)

# --- named shapes ---------------------------------------------------------------

# One value per entity.
TreeIndex, ConstTreeIndex, DistributionTreeIndex = named_shape("Tree", (TREE,))
PathIndex, ConstPathIndex, DistributionPathIndex = named_shape("Path", (PATH,))
CostItemIndex, ConstCostItemIndex, DistributionCostItemIndex = named_shape("CostItem", (COST_ITEM,))
CoverIndex, ConstCoverIndex, DistributionCoverIndex = named_shape("Cover", (COVER,))
LampIndex, ConstLampIndex, DistributionLampIndex = named_shape("Lamp", (LAMP,))
ShelterIndex, ConstShelterIndex, DistributionShelterIndex = named_shape("Shelter", (SHELTER,))
CardIndex, ConstCardIndex, DistributionCardIndex = named_shape("Card", (CARD,))

# One value per entity and year.
TreeTimeseriesIndex, ConstTreeTimeseriesIndex, DistributionTreeTimeseriesIndex = named_shape(
    "TreeTimeseries", (TREE, TIME)
)

# Parameter tables, one value per category.
SpeciesIndex, ConstSpeciesIndex, DistributionSpeciesIndex = named_shape("Species", (SPECIES,))
MaterialIndex, ConstMaterialIndex, DistributionMaterialIndex = named_shape("Material", (MATERIAL,))
