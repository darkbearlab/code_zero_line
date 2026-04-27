/**
 * Tabletop "1 unit distance" = 3 inches. In our 2D pixel world we pick
 * a scale; everything else (close range, command range, charge range,
 * difficult-terrain max move) derives from this.
 */
export const UNIT_DISTANCE_PIXELS = 96;

/** 25mm round base, ~0.78 inch ≈ 0.26 unit. Radius ≈ 13% of one unit. */
export const STANDARD_BASE_RADIUS_PIXELS = UNIT_DISTANCE_PIXELS * 0.13;

export const D6_SIDES = 6;

/** Default hit threshold for X+ rolls when not otherwise specified. */
export const HIT_THRESHOLD_DEFAULT = 5;

/** Damage state thresholds (cumulative hits in a single attack). */
export const DAMAGE_IMPEDE_HITS = 1;
export const DAMAGE_SUPPRESS_HITS = 2;
export const DAMAGE_KILL_HITS = 3;

/** Initiative turnover momentum grants (rule 3.2). */
export const TURNOVER_MOMENTUM_GRANT = 2;

/** Melee support cap (rule 4.7 A). */
export const MELEE_SUPPORT_CAP = 3;
