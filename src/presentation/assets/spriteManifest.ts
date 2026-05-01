/**
 * Sprite asset registry. Each entry generates two textures
 * `${key}-A` and `${key}-B` from `${path}-A.png` / `${path}-B.png`
 * during BootScene preload.
 *
 * Empty by default — this is the plumbing only. Add entries when
 * art lands. Example:
 *   { key: 'trooper', path: 'assets/units/trooper' }
 *
 * After adding here, set `spriteKey: '<key>'` on the matching
 * UnitTemplate JSON to switch from the procedural circle to the sprite.
 */
export interface UnitSpriteEntry {
  readonly key: string;
  readonly path: string;
}

export const UNIT_SPRITES: ReadonlyArray<UnitSpriteEntry> = [];
