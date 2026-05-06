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
  if (t.kind === 'BLOCKER') {
    return {
      fillColor: 0x1a1a1a,
      fillAlpha: 1,
      strokeColor: 0xc04040,
      strokeWidth: 1.5,
    };
  }
  if (t.kind === 'OUT_OF_BOUNDS') {
    // 不可互動區域 — solid red-tinted void with hatching to read as
    // "off-limits boundary" at a glance. Distinct from BLOCKER's grey core.
    return {
      fillColor: 0x2a1010,
      fillAlpha: 0.95,
      strokeColor: 0xff5050,
      strokeWidth: 2,
      hatched: true,
    };
  }
  if (t.kind === 'NO_ENTRY') {
    // 不可進入區 — atrium / void; LOS passes through. Translucent fill +
    // dashed border to suggest "you can see across, but can't walk in".
    return {
      fillColor: 0x102030,
      fillAlpha: 0.35,
      strokeColor: 0x6ab0ff,
      strokeWidth: 2,
      dashed: true,
      hatched: true,
    };
  }
  if (t.kind === 'DOOR') {
    return { fillColor: 0x8a6a3a, fillAlpha: 1, strokeColor: 0xd4a84a, strokeWidth: 2 };
  }
  if (t.kind === 'HIGH_GROUND') {
    return {
      fillColor: 0x6a4a30,
      fillAlpha: 0.6,
      strokeColor: 0xe0a868,
      strokeWidth: 2.5,
    };
  }
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

/**
 * Cyrus–Beck line clip against a convex polygon. Returns the inside portion
 * of segment p0→p1, or null if it never enters the polygon. Polygon winding
 * may be CW or CW; outward normals are recovered by checking against the
 * centroid.
 */
const clipSegmentToConvexPolygon = (
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  poly: ReadonlyArray<{ x: number; y: number }>,
): { a: { x: number; y: number }; b: { x: number; y: number } } | null => {
  let cx = 0;
  let cy = 0;
  for (const v of poly) {
    cx += v.x;
    cy += v.y;
  }
  cx /= poly.length;
  cy /= poly.length;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  let tIn = 0;
  let tOut = 1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    let nx = b.y - a.y;
    let ny = -(b.x - a.x);
    const ex = (a.x + b.x) / 2;
    const ey = (a.y + b.y) / 2;
    if ((cx - ex) * nx + (cy - ey) * ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    const num = nx * (a.x - p0.x) + ny * (a.y - p0.y);
    const den = nx * dx + ny * dy;
    if (Math.abs(den) < 1e-9) {
      if (num < 0) return null;
      continue;
    }
    const t = num / den;
    if (den > 0) {
      if (t < tOut) tOut = t;
    } else {
      if (t > tIn) tIn = t;
    }
  }
  if (tIn > tOut) return null;
  return {
    a: { x: p0.x + dx * tIn, y: p0.y + dy * tIn },
    b: { x: p0.x + dx * tOut, y: p0.y + dy * tOut },
  };
};

/**
 * Diagonal hatching across the polygon. Each hatch line is clipped to the
 * convex polygon boundary so a rotated rectangle's hatch never extends past
 * its actual judgement area (rule 4.7 difficult terrain).
 */
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
  const height = maxY - minY;
  g.lineStyle(1, color, 0.45);
  for (let x = minX; x < maxX + height; x += step) {
    const seg = clipSegmentToConvexPolygon(
      { x, y: minY },
      { x: x - height, y: maxY },
      vertices,
    );
    if (!seg) continue;
    g.beginPath();
    g.moveTo(seg.a.x, seg.a.y);
    g.lineTo(seg.b.x, seg.b.y);
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
  // Open door (non-hinged): draw a faded dashed outline so the player can
  // still see where the doorway is — units pass through freely but the
  // empty frame stays on the map as an unambiguous "this is a passable
  // doorway" marker. Closed doors render as a solid rectangle below.
  if (t.kind === 'DOOR' && t.isOpen && t.doorStyle !== 'hinged') {
    const verts = t.polygon.vertices;
    if (verts.length === 0) return;
    g.lineStyle(2, 0xd4a84a, 0.45);
    strokePolygonDashed(g, verts, true);
    return;
  }
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
