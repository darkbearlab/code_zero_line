/**
 * Hand-crafted mission set for Phase 1 vertical slice. Three missions
 * with the same `engage-reach` scenario but different enemy positions
 * and increasing difficulty. Phase 2 replaces this file with procedural
 * generators across multiple scenario types.
 */
import { v2 } from '../core/geometry/vec2';
import type { MissionDef } from './types';

const MAP_ID = 'demo';

export const MISSION_LIBRARY_V1: ReadonlyArray<MissionDef> = [
  {
    id: 'reconnaissance',
    displayName: '前進偵察',
    description: '掃蕩前哨,佔領目標點即可。',
    mapId: MAP_ID,
    scenario: 'engage-reach',
    enemyFaction: 'B',
    enemies: [
      { id: 'r1-1', templateId: 'conscript', position: v2(652, 115) },
      { id: 'r1-2', templateId: 'conscript', position: v2(599, 168) },
    ],
    playerSpawnPositions: [
      v2(115, 652),
      v2(168, 599),
      v2(80, 700),
      v2(200, 660),
    ],
  },
  {
    id: 'breakthrough',
    displayName: '突破前線',
    description: '正面對決,殺出一條血路。',
    mapId: MAP_ID,
    scenario: 'engage-reach',
    enemyFaction: 'B',
    enemies: [
      { id: 'r2-1', templateId: 'trooper', position: v2(652, 115) },
      { id: 'r2-2', templateId: 'trooper', position: v2(599, 168) },
      { id: 'r2-3', templateId: 'conscript', position: v2(700, 200) },
    ],
    playerSpawnPositions: [
      v2(115, 652),
      v2(168, 599),
      v2(80, 700),
      v2(200, 660),
    ],
  },
  {
    id: 'final_push',
    displayName: '最後攻勢',
    description: '對方主力守備這個點。打贏 run 結束。',
    mapId: MAP_ID,
    scenario: 'engage-reach',
    enemyFaction: 'B',
    enemies: [
      { id: 'r3-1', templateId: 'heavy_gunner', position: v2(652, 115) },
      { id: 'r3-2', templateId: 'elite', position: v2(599, 168) },
      { id: 'r3-3', templateId: 'trooper', position: v2(700, 200) },
      { id: 'r3-4', templateId: 'conscript', position: v2(550, 100) },
    ],
    playerSpawnPositions: [
      v2(115, 652),
      v2(168, 599),
      v2(80, 700),
      v2(200, 660),
    ],
  },
];

export const getMissionById = (id: string): MissionDef => {
  const m = MISSION_LIBRARY_V1.find((x) => x.id === id);
  if (!m) throw new Error(`Mission not found: ${id}`);
  return m;
};
