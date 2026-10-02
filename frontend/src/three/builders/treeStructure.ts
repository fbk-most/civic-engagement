/** Shared recursive branch/twig generator — one procedural structure per
 * tree, used both to build its visible bark (`branches.ts`) and to anchor
 * its leaf cards (`foliageCards.ts`), so the two always agree on the same
 * tree instead of a bare skeleton and a leafy crown being unrelated shapes.
 *
 * This replaced an earlier design where crowns were an independent shell of
 * cards around an idealised sphere/cone/column (see git history on
 * `crown.ts`) — that shell always read as a "flat plate" from some angles no
 * matter how it was tuned, because every card sat tangent to one continuous
 * implicit surface. Anchoring cards to a real (if procedural) branching
 * structure instead means neighbouring cards inherit whatever angle their
 * own twig happens to have grown at, which is what actually breaks the
 * "flat layer" read up close or from above.
 */

import * as THREE from "three";

export type CrownForm = "round" | "conical" | "columnar";

export interface BranchSegment {
  start: THREE.Vector3;
  end: THREE.Vector3;
  radiusStart: number;
  radiusEnd: number;
  level: number;
}

export interface TwigNode {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  level: number;
}

export interface TreeStructure {
  segments: BranchSegment[];
  twigs: TwigNode[];
}

const RADIUS_DECAY = 0.62;
const MIN_RADIUS_M = 0.012;

/** Every segment from this level onward is a candidate leaf anchor — not
 * just the deepest tips — so leaves distribute across the outer portion of
 * the canopy rather than clustering only at the branch ends. */
const LEAF_MIN_LEVEL = 2;

/** Hard recursion ceiling, mostly a safety net — the node budget below is
 * what actually bounds a normal tree. */
const MAX_LEVEL = 6;

/** Caps total segment count per tree regardless of branching factor or
 * depth, so recursion can't blow up a tree's triangle count — same spirit
 * as `foliageCards.ts`'s own cluster-count logic. Settled on this value via
 * `frontend/src/treeLab.ts`'s side-by-side sweep (node budget × round-form
 * `childCountRange`, the two parameters that actually determine structure
 * richness — see that file and `workers/treeWorker.ts`'s `BARK_RENDER_MAX_LEVEL`
 * for why bark-cutoff level alone isn't the useful axis) after several
 * rounds of "too sparse"/"too few branches" feedback tuned blind, one
 * constant at a time, against the full demo scene. */
const NODE_BUDGET = 1200;

/** How wide the dichotomous (round/broadleaf) form spreads its branches:
 * `tiltDeg` is the per-split cone angle away from the parent direction,
 * `childCountRange` how many children each split makes. Conical/columnar
 * (evergreens) don't use this at all — real spruce/fir/pine/cypress don't
 * grow by even dichotomous splitting, they have a dominant central leader
 * with whorls of side branches (see `growConiferLevels` below). */
interface GrowthProfile {
  tiltMinDeg: number;
  tiltMaxDeg: number;
  childCountRange: [number, number];
}

/** `childCountRange` raised from an initial [2,4]: at the lower count a
 * broadleaf tree's visible branch structure read as too sparse — "more
 * maritime pine than Trento tree", i.e. a few widely-spaced limbs with
 * foliage clumped at the ends, rather than the dense, twiggy branching real
 * street trees (plane, lime, horse chestnut) actually have. */
const ROUND_GROWTH: GrowthProfile = { tiltMinDeg: 18, tiltMaxDeg: 45, childCountRange: [3, 5] };

/** How a conifer form's leader/whorl structure differs: `droopDeg` is the
 * branchlet angle measured off the *vertical leader* (not off the parent
 * branch, unlike the dichotomous profile above) — this, more than taper, is
 * what actually separates a pine/fir silhouette (branches near-horizontal)
 * from a cypress one (branches close to upright). `envelopeTaper` is how
 * much branchlet length shrinks from the bottom whorl to the top: 1 tapers
 * fully to a point (the classic Christmas-tree triangle), lower values stay
 * closer to a constant, narrow column. */
interface ConiferProfile {
  droopMinDeg: number;
  droopMaxDeg: number;
  whorlCountRange: [number, number];
  branchletsPerWhorlRange: [number, number];
  envelopeTaper: number;
  // A real conifer's primary (whorl) branches are themselves thin, and carry
  // a further order of secondary branches distributed along their own
  // length (not clustered at the tip) — see growConiferLevels. Both the
  // primary radius factor and the secondary order's own parameters are
  // profile fields so conical (pine/fir, many visible secondaries) and
  // columnar (cypress, tight/minimal) can tune independently.
  primaryRadiusFraction: number;
  /** Secondary count is *density*-driven (one roughly every `secondarySpacingM`
   * of the primary branch's own length, floored at `secondaryMinCount`) —
   * not a flat per-branch range. A flat range put the same handful of
   * secondaries on a long, envelope-widened bottom branch as on a short top
   * one, so the same count read as sparse near the ground and dense near
   * the tip (found by comparing a real in-scene screenshot against the
   * intended pyramid taper — the bottom was nearly bare). */
  secondaryMinCount: number;
  secondarySpacingM: number;
  secondaryRadiusFraction: number;
  /** [near branch base, near branch tip] — secondaries taper shorter toward
   * the primary branch's own tip, the "fishbone" look real conifer branches
   * have. */
  secondaryLengthFraction: [number, number];
  secondaryAngleDeg: [number, number];
}

const FORM_CONIFER: Record<"conical" | "columnar", ConiferProfile> = {
  conical: {
    droopMinDeg: 65, droopMaxDeg: 95, whorlCountRange: [16, 22], branchletsPerWhorlRange: [7, 10], envelopeTaper: 1.0,
    primaryRadiusFraction: 0.28,
    secondaryMinCount: 2,
    secondarySpacingM: 0.3,
    secondaryRadiusFraction: 0.35,
    secondaryLengthFraction: [0.35, 0.15],
    secondaryAngleDeg: [20, 35],
  },
  // Tightened from an initial 25-45°: even "upright" branches at that angle
  // reach far enough from the trunk (over a multi-metre branch length) to
  // read as a wide, splayed fountain shape rather than the tight, narrow
  // spire a real Italian cypress actually is — a real cypress's branches
  // stay close enough to vertical to almost hug the trunk.
  columnar: {
    droopMinDeg: 10, droopMaxDeg: 22, whorlCountRange: [18, 26], branchletsPerWhorlRange: [6, 9], envelopeTaper: 0.3,
    // Cypress foliage reads as dense overlapping sprays hugging the branch
    // rather than distinct fishbone twigs — kept minimal so the already-
    // confirmed-good columnar look isn't disturbed by the new mechanism.
    primaryRadiusFraction: 0.55,
    secondaryMinCount: 1,
    secondarySpacingM: 0.5,
    secondaryRadiusFraction: 0.5,
    secondaryLengthFraction: [0.3, 0.3],
    secondaryAngleDeg: [8, 15],
  },
};

/** Per-whorl leader radius decay — much gentler than the dichotomous
 * grower's `RADIUS_DECAY` (0.62): a conifer's leader tapers over many
 * closely-spaced whorls (16-26, see `FORM_CONIFER`), so decaying at the
 * broadleaf rate left it a sub-pixel thread a third of the way up. */
const CONIFER_LEADER_RADIUS_DECAY = 0.9;

const UP = new THREE.Vector3(0, 1, 0);

/** Small deterministic PRNG, so a tree's structure is identical across
 * reloads for the same element id. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tilts `direction` away from itself by `tiltRad`, around an axis chosen by
 * `azimuthRad`. */
function tiltDirection(direction: THREE.Vector3, tiltRad: number, azimuthRad: number): THREE.Vector3 {
  const reference = Math.abs(direction.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3().crossVectors(direction, reference).normalize();
  const bitangent = new THREE.Vector3().crossVectors(direction, tangent);
  const tiltAxis = tangent.multiplyScalar(Math.cos(azimuthRad)).addScaledVector(bitangent, Math.sin(azimuthRad));
  return direction.clone().applyAxisAngle(tiltAxis, tiltRad).normalize();
}

interface PendingBranch {
  start: THREE.Vector3;
  direction: THREE.Vector3;
  length: number;
  radius: number;
  level: number;
}

/** Grows the whole structure one level at a time (breadth-first) rather
 * than one branch fully to its tip before its siblings even start.
 *
 * This matters for more than traversal order: `NODE_BUDGET` is a *global*
 * cap, and a depth-first walk checks it on every call — so with a
 * branching factor of 2-4 over up to `MAX_LEVEL` levels (hundreds of nodes
 * in the fully-grown case), the very first child explored recurses all the
 * way to its own tips and exhausts the whole budget before any of the
 * trunk's other 1-3 primary branches are ever visited, let alone their
 * own children. The tree that produced silently had only one lopsided
 * branch — everything else returned immediately, having found the budget
 * already spent. Growing level-by-level instead means every branch at a
 * given depth is added before any of them go deeper, so running out of
 * budget only ever trims the finest, deepest twigs symmetrically instead
 * of amputating whole primary limbs unevenly. */
function growLevels(
  random: () => number,
  profile: GrowthProfile,
  structure: TreeStructure,
  root: PendingBranch,
  nodeBudget: number,
  maxLevel: number,
  leafMinLevel: number
): void {
  let frontier: PendingBranch[] = [root];

  while (frontier.length > 0 && structure.segments.length < nodeBudget) {
    const next: PendingBranch[] = [];
    for (const branch of frontier) {
      if (structure.segments.length >= nodeBudget) break;

      const end = branch.start.clone().addScaledVector(branch.direction, branch.length);
      const endRadius = Math.max(branch.radius * RADIUS_DECAY, MIN_RADIUS_M);
      structure.segments.push({
        start: branch.start,
        end,
        radiusStart: branch.radius,
        radiusEnd: endRadius,
        level: branch.level,
      });
      if (branch.level >= leafMinLevel) {
        structure.twigs.push({ position: end, direction: branch.direction, level: branch.level });
      }

      if (branch.level >= maxLevel || endRadius <= MIN_RADIUS_M * 1.01) continue;

      const [minChildren, maxChildren] = profile.childCountRange;
      const childCount = minChildren + Math.floor(random() * (maxChildren - minChildren + 1));
      const baseAzimuth = random() * Math.PI * 2;
      for (let i = 0; i < childCount; i++) {
        // Spread children roughly evenly around the parent, then jitter so
        // they don't fan out in a perfectly even star.
        const azimuth = baseAzimuth + (i / childCount) * Math.PI * 2 + (random() - 0.5) * 0.8;
        const tiltDeg = profile.tiltMinDeg + random() * (profile.tiltMaxDeg - profile.tiltMinDeg);
        const childDirection = tiltDirection(branch.direction, (tiltDeg * Math.PI) / 180, azimuth);
        const childLength = branch.length * (0.58 + random() * 0.2);
        next.push({ start: end, direction: childDirection, length: childLength, radius: endRadius, level: branch.level + 1 });
      }
    }
    frontier = next;
  }
}

/** Grows a conifer's leader-and-whorls structure: a single dominant leader
 * runs almost straight up from `baseY` toward `heightM`, split into whorls;
 * at every whorl but the last, a ring of short, drooping branchlets spreads
 * out, each ending in a couple of finer sub-twigs. Both a branchlet's own
 * tip and its sub-twig tips carry needles — see `LEAF_MIN_LEVEL` below,
 * which this reuses unchanged rather than inventing a parallel eligibility
 * rule.
 *
 * Two things an earlier version of this got visibly wrong, found by
 * rendering it in isolation (`frontend/src/treeLab.ts`) rather than buried
 * in the full demo scene: the leader's final segment was a full whorl
 * *interval* left bare, which at the time's whorl counts read as a long
 * thin antenna sticking out above the crown — fixed by making the tip a
 * short, separately-shrunk segment instead of a normal whorl gap. And the
 * per-branch jitter (azimuth spread, sub-twig tilt) was wide enough that
 * neighbouring branches in the same whorl pointed in near-random
 * directions instead of reading as one coherent radiating tier, which is
 * what actually made it look windswept/spidery rather than tree-shaped —
 * tightened throughout below.
 */
function growConiferLevels(
  random: () => number,
  profile: ConiferProfile,
  structure: TreeStructure,
  baseY: number,
  heightM: number,
  canopyDiameterM: number,
  nodeBudget: number,
  leafMinLevel: number
): void {
  const [minWhorls, maxWhorls] = profile.whorlCountRange;
  const whorlCount = minWhorls + Math.floor(random() * (maxWhorls - minWhorls + 1));

  const rise = Math.max(heightM - baseY, 0.5);
  // The last segment is a short taper-to-point tip, not a normal whorl
  // interval — see the docstring above.
  const tipLength = Math.min(rise * 0.06, 0.4);
  const branchedWhorlCount = Math.max(1, whorlCount - 1);
  const whorlSpacing = (rise - tipLength) / branchedWhorlCount;
  const canopyRadius = canopyDiameterM / 2;

  let leaderStart = new THREE.Vector3(0, baseY, 0);
  let leaderRadius = Math.max(canopyDiameterM / 20, 0.04);

  for (let w = 0; w < whorlCount; w++) {
    if (structure.segments.length >= nodeBudget) return;

    const isTipSegment = w === whorlCount - 1;
    const segmentLength = isTipSegment ? tipLength : whorlSpacing;
    const leaderEnd = leaderStart.clone().addScaledVector(UP, segmentLength);
    const leaderEndRadius = isTipSegment
      ? Math.max(leaderRadius * 0.4, MIN_RADIUS_M)
      : Math.max(leaderRadius * CONIFER_LEADER_RADIUS_DECAY, MIN_RADIUS_M);
    structure.segments.push({
      start: leaderStart,
      end: leaderEnd,
      radiusStart: leaderRadius,
      radiusEnd: leaderEndRadius,
      level: 0,
    });

    if (isTipSegment) {
      // A small tuft at the very tip — real conifers end in a leader spike
      // that still carries some needles, not a bare stick.
      structure.twigs.push({ position: leaderEnd, direction: UP.clone(), level: leafMinLevel });
    } else {
      // Wide at the base, tapering toward the top for a fuller taper
      // (`envelopeTaper` near 1, conical) or staying closer to constant for
      // a narrow column (`envelopeTaper` near 0, columnar).
      const heightFrac = w / Math.max(branchedWhorlCount - 1, 1);
      const envelope = 1 - profile.envelopeTaper * heightFrac;
      const branchletLength = Math.max(canopyRadius * envelope, 0.15);

      const [minBranchlets, maxBranchlets] = profile.branchletsPerWhorlRange;
      const branchletCount = minBranchlets + Math.floor(random() * (maxBranchlets - minBranchlets + 1));
      const baseAzimuth = random() * Math.PI * 2;

      for (let i = 0; i < branchletCount; i++) {
        if (structure.segments.length >= nodeBudget) break;

        // Tight jitter relative to an even spread — a real whorl's branches
        // radiate as coherent spokes, not independently-random directions.
        const azimuth = baseAzimuth + (i / branchletCount) * Math.PI * 2 + (random() - 0.5) * 0.25;
        const droopDeg = profile.droopMinDeg + random() * (profile.droopMaxDeg - profile.droopMinDeg);
        const branchletDir = tiltDirection(UP, (droopDeg * Math.PI) / 180, azimuth);
        const branchletActualLength = branchletLength * (0.85 + random() * 0.25);
        const branchletRadius = Math.max(leaderEndRadius * profile.primaryRadiusFraction, MIN_RADIUS_M);
        const branchletEnd = leaderEnd.clone().addScaledVector(branchletDir, branchletActualLength);
        const branchletEndRadius = Math.max(branchletRadius * RADIUS_DECAY, MIN_RADIUS_M);
        structure.segments.push({
          start: leaderEnd,
          end: branchletEnd,
          radiusStart: branchletRadius,
          radiusEnd: branchletEndRadius,
          level: 1,
        });
        // The branchlet's own tip is a needle anchor too, not just its
        // secondary branches below — denser coverage, and keeps the whorl
        // looking full even where a secondary's own jitter points it
        // awkwardly.
        structure.twigs.push({ position: branchletEnd, direction: branchletDir, level: leafMinLevel });

        // Secondary branches distributed along the primary branchlet's own
        // length — real bark, not a needle-only anchor — angled off the
        // branchlet's own local direction and tapering shorter toward its
        // tip (the "fishbone" pattern real conifer branches have). This
        // replaced an earlier version that only had needle-only anchors
        // spread along the branchlet plus a couple of short bark sub-twigs
        // clustered at its very tip — found (comparing against real pine
        // photos) to read as "a few thick limbs with foliage pom-poms at
        // the ends" rather than "many small branches with needles along
        // their length", which is what a real pine/fir actually looks like.
        // Density-driven, not a flat count — see secondarySpacingM's
        // docstring. A long, envelope-widened branch near the base of the
        // crown gets proportionally more secondaries than a short one near
        // the tip, instead of the same handful spread thin.
        const secondaryCount = Math.max(
          profile.secondaryMinCount,
          Math.round(branchletActualLength / profile.secondarySpacingM)
        );
        const [lengthNearBase, lengthNearTip] = profile.secondaryLengthFraction;
        const [angleMinDeg, angleMaxDeg] = profile.secondaryAngleDeg;

        for (let sIdx = 0; sIdx < secondaryCount; sIdx++) {
          if (structure.segments.length >= nodeBudget) break;

          // Spread along the branchlet's length, from just past its base to
          // just short of its own tip (which already has its own needle
          // anchor above).
          const t = (sIdx + 1) / (secondaryCount + 1);
          const localRadius = branchletRadius + (branchletEndRadius - branchletRadius) * t;
          const secondaryStart = leaderEnd.clone().lerp(branchletEnd, t);

          const secondaryAzimuth = random() * Math.PI * 2;
          const secondaryTiltDeg = angleMinDeg + random() * (angleMaxDeg - angleMinDeg);
          const secondaryDir = tiltDirection(branchletDir, (secondaryTiltDeg * Math.PI) / 180, secondaryAzimuth);

          const lengthFraction = lengthNearBase + (lengthNearTip - lengthNearBase) * t;
          const secondaryLength = Math.max(branchletActualLength * lengthFraction * (0.8 + random() * 0.4), 0.08);
          const secondaryRadius = Math.max(localRadius * profile.secondaryRadiusFraction, MIN_RADIUS_M);
          const secondaryEnd = secondaryStart.clone().addScaledVector(secondaryDir, secondaryLength);
          const secondaryEndRadius = Math.max(secondaryRadius * RADIUS_DECAY, MIN_RADIUS_M);
          structure.segments.push({
            start: secondaryStart,
            end: secondaryEnd,
            radiusStart: secondaryRadius,
            radiusEnd: secondaryEndRadius,
            level: leafMinLevel,
          });
          structure.twigs.push({ position: secondaryEnd, direction: secondaryDir, level: leafMinLevel });

          // One extra needle-only point partway along the secondary's own
          // (short) length — cheap fill (no bark cost), same trick the
          // primary branchlet used to use over its whole length.
          const midPoint = secondaryStart.clone().lerp(secondaryEnd, 0.5 + random() * 0.3);
          structure.twigs.push({ position: midPoint, direction: secondaryDir, level: leafMinLevel });
        }
      }
    }

    leaderStart = leaderEnd;
    leaderRadius = leaderEndRadius;
  }
}

/** Overrides for the parameters that actually determine how rich a
 * generated structure is — see `frontend/src/treeLab.ts`, the tool this
 * exists for. All optional; omitting them (as every real call site except
 * the lab does) reproduces today's shipped defaults exactly. */
export interface RoundGrowthOverrides {
  tiltMinDeg?: number;
  tiltMaxDeg?: number;
  childCountRange?: [number, number];
}

export interface ConiferOverrides {
  droopMinDeg?: number;
  droopMaxDeg?: number;
  whorlCountRange?: [number, number];
  branchletsPerWhorlRange?: [number, number];
  envelopeTaper?: number;
  primaryRadiusFraction?: number;
  secondaryMinCount?: number;
  secondarySpacingM?: number;
  secondaryRadiusFraction?: number;
  secondaryLengthFraction?: [number, number];
  secondaryAngleDeg?: [number, number];
}

export interface TreeStructureOptions {
  nodeBudget?: number;
  maxLevel?: number;
  leafMinLevel?: number;
  roundGrowth?: RoundGrowthOverrides;
  conifer?: ConiferOverrides;
}

/** Builds one tree's branch/twig structure, from `baseY` (where
 * `vegetation.ts`'s trunk cylinder ends — this continues it) up to roughly
 * `heightM`. `canopyDiameterM` only sets the starting radius; horizontal
 * spread emerges from the branching angles rather than being fitted to it.
 */
export function buildTreeStructure(
  seed: number,
  baseY: number,
  heightM: number,
  canopyDiameterM: number,
  crownForm: CrownForm,
  options?: TreeStructureOptions
): TreeStructure {
  const random = mulberry32(seed);
  const structure: TreeStructure = { segments: [], twigs: [] };
  const nodeBudget = options?.nodeBudget ?? NODE_BUDGET;
  const maxLevel = options?.maxLevel ?? MAX_LEVEL;
  const leafMinLevel = options?.leafMinLevel ?? LEAF_MIN_LEVEL;

  if (crownForm === "conical" || crownForm === "columnar") {
    const coniferProfile: ConiferProfile = { ...FORM_CONIFER[crownForm], ...options?.conifer };
    growConiferLevels(random, coniferProfile, structure, baseY, heightM, canopyDiameterM, nodeBudget, leafMinLevel);
    return structure;
  }

  const rise = Math.max(heightM - baseY, 0.5);
  const firstLength = rise * 0.42;
  const firstRadius = Math.max(canopyDiameterM / 24, 0.03);
  const roundProfile: GrowthProfile = { ...ROUND_GROWTH, ...options?.roundGrowth };

  growLevels(
    random,
    roundProfile,
    structure,
    {
      start: new THREE.Vector3(0, baseY, 0),
      direction: UP.clone(),
      length: firstLength,
      radius: firstRadius,
      level: 0,
    },
    nodeBudget,
    maxLevel,
    leafMinLevel
  );

  return structure;
}
