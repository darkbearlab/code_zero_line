import Phaser from 'phaser';
import { isHighWall, isLowWall, type Terrain } from '../../core/state/GameState';
import { VAULT_HEIGHT_THRESHOLD_PIXELS } from '../../core/rules/constants';

interface TerrainStyle {
  fillColor: number;
  fillAlpha: number;
  strokeColor: number;
  strokeWidth: number;
  /** Optional dashed border to suggest "edge stops you" semantics. */
  dashed?: boolean;
  /** Optional inset hatching (light pattern) for difficult terrain. */
  hatched?: boolean;
}

const styleFor = (t: Terrain): TerrainStyle => {
  if (isHighWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS)) {
    return {
      fillColor: 0x3a3a3a,
      fillAlpha: 1,
      strokeColor: 0x9a9a9a,
      strokeWidth: 1.5,
    };
  }
  if (isLowWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS)) {
    return {
      fillColor: 0x7a7a6a,
      fillAlpha: 1,
      strokeColor: 0xcfcfaf,
      strokeWidth: 1,
    };
  }
  if (t.kind === 'DIFFICULT') {
    return {
      fillColor: 0x5a4a30,
      fillAlpha: 0.55,
      strokeColor: 0xa78a4a,
      strokeWidth: 1.5,
      dashed: true,
      hatched: true,
    };
  }
  // SOFT
  return {
    fillColor: 0xb0b8c8,
    fillAlpha: 0.35,
    strokeColor: 0xdfe4ee,
    strokeWidth: 1.5,
    dashed: true,
  };
};

/** Stroke a polygon with optional dashed segments (manual since Graphics has no dash). */
const strokePolygonDashed = (
  g: Phaser.GameObjects.Graphics,
  vertices: ReadonlyArray<{ x: number; y: number }>,
  dashed: boolean,
): void => {
  if (vertices.length < 2) return;
  if (!dashed) {
    g.beginPath();
    g.moveTo(vertices[0]!.x, vertices[0]!.y);
    for (let i = 1; i < vertices.length; i++) {
      g.lineTo(vertices[i]!.x, vertices[i]!.y);
    }
    g.closePath();
    g.strokePath();
    return;
  }
  const dashLen = 6;
  const gapLen = 4;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const ux = dx / len;
    const uy = dy / len;
    let dist = 0;
    while (dist < len) {
      const segLen = Math.min(dashLen, len - dist);
      g.beginPath();
      g.moveTo(a.x + ux * dist, a.y + uy * dist);
      g.lineTo(a.x + ux * (dist + segLen), a.y + uy * (dist + segLen));
      g.strokePath();
      dist += dashLen + gapLen;
    }
  }
};

/** Draw a hatched cross-pattern across a polygon's bbox, clipped via fill alpha. */
const drawHatch = (
  g: Phaser.GameObjects.Graphics,
  vertices: ReadonlyArray<{ x: number; y: number }>,
  color: number,
): void => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of vertices) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const step = 8;
  g.lineStyle(1, color, 0.45);
  for (let x = minX; x < maxX + maxY - minY; x += step) {
    g.beginPath();
    g.moveTo(x, minY);
    g.lineTo(x - (maxY - minY), maxY);
    g.strokePath();
  }
};

/**
 * Render a single terrain tile into the supplied Graphics object. Optionally
 * adds a small label text showing the displayName at the polygon centroid;
 * the caller is responsible for adding/destroying the label as needed.
 */
export const drawTerrain = (
  g: Phaser.GameObjects.Graphics,
  t: Terrain,
): void => {
  const verts = t.polygon.vertices;
  if (verts.length === 0) return;
  const style = styleFor(t);

  // Fill polygon.
  g.fillStyle(style.fillColor, style.fillAlpha);
  g.beginPath();
  g.moveTo(verts[0]!.x, verts[0]!.y);
  for (let i = 1; i < verts.length; i++) {
    g.lineTo(verts[i]!.x, verts[i]!.y);
  }
  g.closePath();
  g.fillPath();

  if (style.hatched) {
    drawHatch(g, verts, style.strokeColor);
  }

  g.lineStyle(style.strokeWidth, style.strokeColor, 1);
  strokePolygonDashed(g, verts, !!style.dashed);
};

/** Compute a polygon centroid (rough — average of vertices). */
export const polygonCentroid = (
  vertices: ReadonlyArray<{ x: number; y: number }>,
): { x: number; y: number } => {
  let cx = 0;
  let cy = 0;
  for (const v of vertices) {
    cx += v.x;
    cy += v.y;
  }
  return { x: cx / vertices.length, y: cy / vertices.length };
};
