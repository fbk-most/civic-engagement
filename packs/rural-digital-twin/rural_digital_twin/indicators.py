"""The rural indicators: placeholders of the stub model (model.py) — the
forest's area and the areas planted and felled — until the real model
brings real ones."""

from civic_engagement.models.schema import (
    IndicatorDescriptor,
    IndicatorDescriptors,
    IndicatorGroup,
    IndicatorValues,
)
from rural_digital_twin.model import Evaluated, forest_ha, state_at

DESCRIPTORS = IndicatorDescriptors(
    groups=[IndicatorGroup(id="forest", label="Bosco", label_en="Forest")],
    indicators=[
        IndicatorDescriptor(
            id="forest_ha", group="forest", kind="number",
            label="Superficie boscata", label_en="Forest area", unit=" ha", decimals=0, key=True,
        ),
        IndicatorDescriptor(
            id="planted_ha", group="forest", kind="number",
            label="Superficie rimboschita", label_en="Area planted", unit=" ha", decimals=1, key=True,
            scenario_only=True,
        ),
        IndicatorDescriptor(
            id="felled_ha", group="forest", kind="number",
            label="Superficie tagliata", label_en="Area felled", unit=" ha", decimals=1, key=True,
            scenario_only=True,
        ),
    ],
)


def indicator_values(evaluated: Evaluated, t: int) -> IndicatorValues:
    state = state_at(evaluated, t)
    return {
        "forest_ha": round(forest_ha(evaluated, t), 0),
        "planted_ha": round(state.planted_ha, 1),
        "felled_ha": round(state.felled_ha, 1),
    }
