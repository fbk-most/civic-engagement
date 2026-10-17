"""The urban indicators as the app shows them: their descriptors (what the
frontend knows about them) and their values at a year, from a model
evaluation (model.py) and from the felt-temperature field (thermal_field.py).

Values are rounded for display here, once: the descriptors' `decimals` only
format them.
"""

import math

import numpy as np

from bologna_civic_dt.model import COVER_TYPES, INCLUSION_GROUPS, UrbanOutput
from civic_engagement.models.schema import (
    IndicatorDescriptor,
    IndicatorDescriptors,
    IndicatorGroup,
    IndicatorPart,
    IndicatorValues,
)

# Cover types counted as "green" ground. Tree canopy isn't a cover type (it
# overhangs whatever ground is below it), so it doesn't count here — hence
# "Superficie verde", not "Copertura arborea".
GREEN_COVER_TYPES = ["lawn", "meadow", "wood"]

DESCRIPTORS = IndicatorDescriptors(
    groups=[
        IndicatorGroup(id="space"),
        IndicatorGroup(id="climate", label="Clima e ambiente", label_en="Climate and environment"),
        IndicatorGroup(id="accessibility", label="Accessibilità", label_en="Accessibility"),
        IndicatorGroup(id="social", label="Sicurezza e inclusività", label_en="Safety and inclusivity"),
        IndicatorGroup(id="costs", label="Costi", label_en="Costs"),
    ],
    indicators=[
        # Parts left to the frontend's cover types (labels and colours) for
        # now.
        IndicatorDescriptor(
            id="space_use_pct", group="space", kind="breakdown",
            label="Uso dello spazio", label_en="Use of space", unit="%", decimals=1,
        ),
        IndicatorDescriptor(
            id="felt_temperature", group="climate", kind="number",
            label="Temperatura percepita (21 giugno, ore 11)", label_en="Felt temperature (21 June, 11:00)",
            short_label="Temp. percepita, 21/6 ore 11", short_label_en="Felt temp., 21 June 11:00",
            unit=" °C", decimals=1, better="lower", key=True, deferred=True,
        ),
        # Not charted (space use is): here for its place among the key
        # indicators, which follow the descriptors' order.
        IndicatorDescriptor(
            id="green_surface_pct", group="climate", kind="number",
            label="Superficie verde", label_en="Green surface", unit="%", decimals=1,
            better="higher", key=True, chart=False,
        ),
        IndicatorDescriptor(
            id="heat_stress_pct", group="climate", kind="number",
            label="Area in stress da caldo (21 giugno, ore 11)", label_en="Area in heat stress (21 June, 11:00)",
            unit="%", decimals=1, better="lower", deferred=True,
        ),
        IndicatorDescriptor(
            id="sunlit_pct", group="climate", kind="number",
            label="Area al sole (21 giugno, ore 11)", label_en="Area in the sun (21 June, 11:00)",
            unit="%", decimals=1, chart=False, deferred=True,
        ),
        IndicatorDescriptor(
            id="co2_annual", group="climate", kind="number",
            label="CO₂ assorbita all'anno", label_en="CO₂ absorbed per year",
            short_label="CO₂ assorbita", short_label_en="CO₂ absorbed",
            unit=" kg/anno", unit_en=" kg/year", decimals=0, better="higher", key=True,
        ),
        IndicatorDescriptor(
            id="co2_cumulative", group="climate", kind="number",
            label="CO₂ assorbita da oggi (cumulata)", label_en="CO₂ absorbed from today (cumulative)",
            unit=" kg", decimals=0, better="higher",
        ),
        IndicatorDescriptor(
            id="walkability", group="accessibility", kind="number",
            label="Percorribilità pedonale", label_en="Walkability", decimals=1, better="higher",
        ),
        IndicatorDescriptor(
            id="fragile_path_pct", group="accessibility", kind="number",
            label="Percorsi fragili", label_en="Fragile paths", unit="%", decimals=1, better="lower",
        ),
        IndicatorDescriptor(
            id="safety", group="social", kind="number",
            label="Sicurezza percepita", label_en="Perceived safety", unit="%", decimals=1, better="higher",
        ),
        IndicatorDescriptor(
            id="evening_winter", group="social", kind="number",
            label="Utilizzo serale/invernale", label_en="Evening/winter use", unit="%", decimals=1, better="higher",
        ),
        IndicatorDescriptor(
            id="age_inclusion", group="social", kind="flags",
            label="Spazio adatto a…", label_en="Space suited to…",
            parts=[
                IndicatorPart(id="bambini", label="Bambini", label_en="Children"),
                IndicatorPart(id="giovani", label="Giovani", label_en="Young people"),
                IndicatorPart(id="generale", label="Generale", label_en="Everyone"),
            ],
        ),
        IndicatorDescriptor(
            id="cost", group="costs", kind="number",
            label="Costo degli interventi realizzati", label_en="Cost of the interventions built",
            short_label="Costo interventi", short_label_en="Cost of interventions",
            unit=" €", decimals=0, better="lower", scenario_only=True, key=True,
        ),
        IndicatorDescriptor(
            id="maintenance_annual", group="costs", kind="number",
            label="Manutenzione aggiuntiva all'anno", label_en="Added maintenance per year",
            short_label="Manutenzione aggiuntiva", short_label_en="Added maintenance",
            unit=" €/anno", unit_en=" €/year", decimals=0, better="lower", scenario_only=True, key=True,
        ),
        IndicatorDescriptor(
            id="maintenance_cumulative", group="costs", kind="number",
            label="Manutenzione aggiuntiva da oggi (cumulata)", label_en="Added maintenance from today (cumulative)",
            unit=" €", decimals=0, better="lower", scenario_only=True,
        ),
    ],
)

DEFERRED_IDS = [d.id for d in DESCRIPTORS.indicators if d.deferred]


def _optional(value: float, digits: int) -> float | None:
    return None if math.isnan(value) else round(value, digits)


def indicator_values(output: UrbanOutput, t: int) -> IndicatorValues:
    """Every indicator but the deferred ones, at year t."""
    ind = output.indicators

    def at(name: str) -> float:
        return float(ind[name][t])

    space_use = {
        cover_type: round(float(v), 1)
        for cover_type, v in zip(COVER_TYPES, ind["space_use_pct"][:, t])
        if not np.isnan(v)
    }
    return {
        "space_use_pct": space_use,
        # Summed from the rounded shares, as the key indicators panel used to.
        "green_surface_pct": round(sum(space_use.get(c, 0.0) for c in GREEN_COVER_TYPES), 1),
        "co2_annual": round(at("co2_annual"), 1),
        "co2_cumulative": round(at("co2_cumulative"), 1),
        "walkability": _optional(at("walkability"), 1),
        "fragile_path_pct": _optional(at("fragile_path_pct"), 1),
        "safety": round(at("safety"), 1),
        "evening_winter": round(at("evening_winter"), 1),
        "age_inclusion": {group: bool(v > 0.5) for group, v in zip(INCLUSION_GROUPS, ind["inclusion"][:, t])},
        "cost": round(at("cost"), 2),
        "maintenance_annual": round(at("maintenance"), 2),
        "maintenance_cumulative": round(at("maintenance_cumulative"), 2),
    }


def thermal_values(mean_felt: float, heat_stress_pct: float, sunlit_pct: float) -> IndicatorValues:
    """The deferred indicators: the felt-temperature field at the reference
    moment (parameters.THERMAL_REFERENCE)."""
    return {
        "felt_temperature": round(float(mean_felt), 1),
        "heat_stress_pct": round(float(heat_stress_pct), 1),
        "sunlit_pct": round(float(sunlit_pct), 1),
    }
