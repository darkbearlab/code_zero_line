import { describe, it, expect } from 'vitest';
import { v2 } from '../../core/geometry/vec2';
import type { MapDef } from '../../core/setup/types';
import { probeMapTraversal } from './probe';

const openMap: MapDef = {
  id: 'open',
  displayName: 'open',
  size: 256,
  terrain: [],
  deploymentZones: [
    {
      id: 'a',
      faction: 'A',
      polygon: { vertices: [v2(0, 240), v2(256, 240), v2(256, 256), v2(0, 256)] },
    },
    {
      id: 'b',
      faction: 'B',
      polygon: { vertices: [v2(0, 0), v2(256, 0), v2(256, 16), v2(0, 16)] },
    },
  ],
};

const blockedMap: MapDef = {
  id: 'sealed',
  displayName: 'sealed',
  size: 256,
  terrain: [
    {
      id: 'wall',
      kind: 'HARD',
      height: 200,
      polygon: { vertices: [v2(0, 100), v2(256, 100), v2(256, 156), v2(0, 156)] },
    },
  ],
  deploymentZones: openMap.deploymentZones,
};

describe('probeMapTraversal', () => {
  it('reports 100% A↔B traversal on an open map', () => {
    const r = probeMapTraversal(openMap, { samplesPerZone: 3, cellSize: 16 });
    expect(r.aToB.successRate).toBe(1);
    expect(r.bToA.successRate).toBe(1);
    expect(r.aToB.attempts.length).toBe(9); // 3 × 3 pairs
  });

  it('reports 0% when a wall fully splits the map', () => {
    const r = probeMapTraversal(blockedMap, { samplesPerZone: 3, cellSize: 16 });
    expect(r.aToB.successRate).toBe(0);
    expect(r.bToA.successRate).toBe(0);
    // Failures should record a NO_PATH reason.
    expect(Object.keys(r.aToB.failureReasons)).toContain('NO_PATH');
  });

  it('throws when a deployment zone is missing', () => {
    const incompleteMap: MapDef = {
      ...openMap,
      deploymentZones: [openMap.deploymentZones[0]!],
    };
    expect(() => probeMapTraversal(incompleteMap)).toThrow(/missing/);
  });
});
