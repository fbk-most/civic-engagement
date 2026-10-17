/** How people fare in the felt temperature, hour by hour through one day:
 * the figures behind the thermal panel's daily curve.
 *
 * Expected values, not the 3D view's crowd: for the people who stop, what
 * `planCrowd` expects of every spot; for walkers, their usual number on the
 * site, thinned by `passFactor`, and in stress as much as the site's paths
 * are. So the curve is the same whatever the 3D view shows (or whether it's
 * open), and doesn't flicker as walkers move.
 */

import type { DiscreteElement } from "../../api/types";
import { layerAt, summaryAt, valueAt, type ThermalField } from "../../thermal/field";
import type { GeoAnchor } from "../geo";
import { sunPosition } from "../sun";
import type { Footprint } from "../walk";
import { crowdActivity } from "./activity";
import { networkExposure, type FeltSampler } from "./comfort";
import type { WalkNetwork } from "./network";
import { planCrowd, walkerCount, type StopTally } from "./plan";

export interface HourComfort {
  /** 0-1: of the people on the site, the share in thermal stress; null
   * with nobody around. */
  stressed: number | null;
  /** 0-1: of the people who'd be on the site in comfortable weather, the
   * share the temperature keeps away; null with nobody around. */
  missing: number | null;
}

export interface DayInput {
  /** The scene's elements as built for this variant (with or without the
   * interventions), and the walking network over them. */
  elements: DiscreteElement[];
  network: WalkNetwork;
  anchor: GeoAnchor;
  site: Footprint;
  field: ThermalField;
  month: number;
  day: number;
  year: number;
}

export const DAY_HOURS = 24;

export function dailyComfort(input: DayInput): HourComfort[] {
  const { elements, network, anchor, site, field, month, day, year } = input;
  return Array.from({ length: DAY_HOURS }, (_, hour) => {
    const setting = { month, day, hour };
    const activity = crowdActivity(setting, sunPosition(setting, year, anchor.lat0, anchor.lng0).altitudeDeg);
    const layer = layerAt(field, hour);
    const onField: FeltSampler = (x, z) => valueAt(field, layer, x, -z);
    const elsewhere = summaryAt(field.meanFelt, hour);
    const felt: FeltSampler = (x, z) => onField(x, z) ?? elsewhere;

    // Footprints don't matter here: spots inside buildings are few, and
    // excluded the same way with the interventions and without.
    const tally: StopTally = { wouldStop: 0, stop: 0, stressed: 0 };
    planCrowd(elements, anchor, [], site, activity, felt, tally);

    const paths = networkExposure(network, onField);
    const usualWalkers = paths.length > 0 ? (walkerCount(activity) * paths.onSite) / paths.length : 0;
    const walkers = usualWalkers * paths.pass;
    const walkersStressed = paths.onSite > 0 ? (walkers * paths.stressed) / paths.onSite : 0;

    const people = tally.stop + walkers;
    const usual = tally.wouldStop + usualWalkers;
    return {
      stressed: people > 0 ? (tally.stressed + walkersStressed) / people : null,
      missing: usual > 0 ? 1 - people / usual : null,
    };
  });
}
