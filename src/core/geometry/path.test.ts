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

  it('exitStopPolygons: leaving high ground stops with base flush against inner edge', () => {
    // Platform spans x ∈ [0, 100], y ∈ [-50, 50]. Mover starts inside at
    // (50, 0), targets (200, 0). Should stop with centre at x=90 (base
    // flush against the inner edge at x=100). Crossing requires CLIMB.
    const platform = {
      vertices: [v2(0, -50), v2(100, -50), v2(100, 50), v2(0, 50)],
    };
    const r = computeMovePath(v2(50, 0), v2(200, 0), {
      polygons: [],
      exitStopPolygons: [platform],
      enemyCircles: [],
      moverRadius: 10,
    });
    expect(r.stopReason).toBe('OBSTACLE');
    expect(r.endpoint.x).toBeCloseTo(90, 1);
    // Travel inside the polygon doesn't trigger the stop on its own — only
    // base-touching the inner edge does.
    const inside = computeMovePath(v2(20, 0), v2(80, 0), {
      polygons: [],
      exitStopPolygons: [platform],
      enemyCircles: [],
      moverRadius: 10,
    });
    expect(inside.stopReason).toBe('TARGET');
    expect(inside.endpoint.x).toBeCloseTo(80);
  });

  it('exitStopPolygons: a mover starting outside is not affected', () => {
    const platform = {
      vertices: [v2(0, -50), v2(100, -50), v2(100, 50), v2(0, 50)],
    };
    const r = computeMovePath(v2(-50, 0), v2(50, 0), {
      polygons: [],
      exitStopPolygons: [platform],
      enemyCircles: [],
      moverRadius: 10,
    });
    expect(r.stopReason).toBe('TARGET');
    expect(r.endpoint.x).toBeCloseTo(50);
  });
});
