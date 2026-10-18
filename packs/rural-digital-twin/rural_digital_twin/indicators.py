"""The rural indicators: placeholders of the stub model (model.py), the
areas planted and felled, until the real model brings real ones."""

from civic_engagement.models.schema import (
    IndicatorDescriptor,
    IndicatorDescriptors,
    IndicatorGroup,
    IndicatorValues,
)
from rural_digital_twin.model import Evaluated, active

DESCRIPTORS = IndicatorDescriptors(
    groups=[IndicatorGroup(id="forest", label="Bosco", label_en="Forest")],
    indicators=[
        IndicatorDescriptor(
            id="planted_ha", group="forest", kind="number",
            label="Superficie rimboschita", label_en="Area planted", unit=" ha", decimals=1, key=True,
        ),
        IndicatorDescriptor(
            id="felled_ha", group="forest", kind="number",
            label="Superficie tagliata", label_en="Area felled", unit=" ha", decimals=1, key=True,
        ),
    ],
)


def indicator_values(evaluated: Evaluated, t: int) -> IndicatorValues:
    planted = sum(ha for iv, ha in active(evaluated, t) if iv.card_type == "plant_forest")
    felled = sum(ha for iv, ha in active(evaluated, t) if iv.card_type == "fell_forest")
    return {"planted_ha": round(planted, 1), "felled_ha": round(felled, 1)}
