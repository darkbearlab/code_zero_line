import { describe, it, expect } from 'vitest';
import { computeMovePath } from './path';
import { v2 } from './vec2';

describe('computeMovePath', () => {
  it('reaches target in empty space', () => {
    const r = computeMovePath(v2(0, 0), v2(100, 0), {
      polygons: [],
      enemyCircles: [],
      moverRadius: 10,
    });
    expect(r.stopReason).toBe('TARGET');
    expect(r.t).toBeCloseTo(1);
    expect(r.endpoint.x).toBeCloseTo(100);
    expect(r.distance).toBeCloseTo(100);
  });

  it('stops at wall and backs off by mover radius', () => {
    const wall = {
      vertices: [v2(50, -100), v2(50, 100), v2(60, 100), v2(60, -100)],
    };
    const r = computeMovePath(v2(0, 0), v2(100, 0), {
      polygons: [wall],
      enemyCircles: [],
      moverRadius: 10,
    });
    expect(r.stopReason).toBe('OBSTACLE');
    // Wall edge at x=50, mover radius 10 → endpoint x ≈ 40.
    expect(r.endpoint.x).toBeLessThan(50);
    expect(r.endpoint.x).toBeGreaterThan(35);
  });

  it('stops at enemy circle (radii summed)', () => {
    const r = computeMovePath(v2(0, 0), v2(100, 0), {
      polygons: [],
      enemyCircles: [{ center: v2(70, 0), radius: 10 }],
      moverRadius: 10,
    });
    expect(r.stopReason).toBe('ENEMY');
    // Contact at x = 70 - (10 + 10) = 50.
    expect(r.endpoint.x).toBeCloseTo(50, 0);
  });

  it('zero-distance move stays put', () => {
    const r = computeMovePath(v2(42, 17), v2(42, 17), {
      polygons: [],
      enemyCircles: [],
      moverRadius: 10,
    });
    expect(r.t).toBe(0);
    expect(r.distance).toBe(0);
  });

  it('chooses the closest blocker when wall and enemy compete', () => {
    const wall = {
      vertices: [v2(80, -100), v2(80, 100), v2(90, 100), v2(90, -100)],
    };
    const r = computeMovePath(v2(0, 0), v2(100, 0), {
      polygons: [wall],
      enemyCircles: [{ center: v2(40, 0), radius: 5 }],
      moverRadius: 10,
    });
    expect(r.stopReason).toBe('ENEMY');
    expect(r.endpoint.x).toBeLessThan(40);
  });
});
