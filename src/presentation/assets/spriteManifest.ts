/**
 * Sprite asset registry. Each entry registers one Phaser texture under
 * `entry.key` from `entry.path` (a path relative to `public/`, including
 * extension) during BootScene preload.
 *
 * Faction differentiation is handled by tinting at render time
 * (BattleScene reads `Faction.color` from the matching factionTag and
 * calls `setTint`), so a single PNG per spriteKey is sufficient.
 *
 * Convention for the PNG itself:
 *   - Square aspect; transparent background
 *   - Top-down view, the sprite "front" pointing right (+x), so it
 *     aligns with the chevron / `unitFacings` angle 0 with no offset
 *
 * To enable a sprite on a unit template, add a matching `spriteKey` to
 * the template JSON (or via the Units editor tab).
 */
export interface UnitSpriteEntry {
  readonly key: string;
  /** Path relative to `public/`, with extension. E.g. 'assets/units/foo.png'. */
  readonly path: string;
}

export const UNIT_SPRITES: ReadonlyArray<UnitSpriteEntry> = [
  { key: 'man_with_rifle', path: 'assets/units/man_with_rifle_00.png' },
  { key: 'men_prone', path: 'assets/units/men_prone.png' },
];
