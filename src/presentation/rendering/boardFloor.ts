/**
 * Board floor — 1-UD light checkerboard. Used by every view that shows the
 * battlefield (BattleScene, DeployScene, ReplayScene, map editor, mission
 * editor) so map context is consistent and sprites get a bright contrast
 * background.
 */
import Phaser from 'phaser';
import { UNIT_DISTANCE_PIXELS } from '../../core/rules/constants';

const TILE_LIGHT_NUM = 0xf0f0f0;
const TILE_DARK_NUM = 0xd6d6d6;
const TILE_LIGHT_HEX = '#f0f0f0';
const TILE_DARK_HEX = '#d6d6d6';

export const paintBoardFloorPhaser = (
  gfx: Phaser.GameObjects.Graphics,
  size: number,
): void => {
  const tile = UNIT_DISTANCE_PIXELS;
  const cols = Math.ceil(size / tile);
  const rows = Math.ceil(size / tile);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      gfx.fillStyle((r + c) % 2 === 0 ? TILE_LIGHT_NUM : TILE_DARK_NUM, 1);
      gfx.fillRect(c * tile, r * tile, tile, tile);
    }
  }
};

export const paintBoardFloorCanvas = (
  ctx: CanvasRenderingContext2D,
  size: number,
): void => {
  const tile = UNIT_DISTANCE_PIXELS;
  const cols = Math.ceil(size / tile);
  const rows = Math.ceil(size / tile);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? TILE_LIGHT_HEX : TILE_DARK_HEX;
      ctx.fillRect(c * tile, r * tile, tile, tile);
    }
  }
};
