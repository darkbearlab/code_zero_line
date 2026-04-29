/**
 * Hand-crafted mission set. Phase 2 spreads three scenarios across one run
 * so the player feels distinct gameplay shapes — push for a foothold, hold
 * the line, then race to extract — rather than three back-to-back slugfests.
 *
 * Procedural generators + per-region weighting come in a later phase.
 */
import { v2 } from '../core/geometry/vec2';
import type { MissionDef } from './types';

const MAP_ID = 'demo';

export const MISSION_LIBRARY_V1: ReadonlyArray<MissionDef> = [
  {
    id: 'reconnaissance',
    displayName: '前進偵察',
    description: '佔領敵方前哨,並至少擊倒一名敵兵。',
    mapId: MAP_ID,
    scenario: 'engage-reach',
    objectives: [
      {
        id: 'recon-objective',
        position: v2(384, 130),
        radius: 36,
        displayName: '前哨',
      },
    ],
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
    id: 'holdout',
    displayName: '陣地堅守',
    description: '守住中央哨點 5 個回合,別讓敵人踏入半步。',
    mapId: MAP_ID,
    scenario: 'defend',
    scenarioParams: { defendRounds: 5 },
    objectives: [
      {
        id: 'holdout-objective',
        position: v2(384, 540),
        radius: 40,
        displayName: '哨點',
      },
    ],
    enemyFaction: 'B',
    enemies: [
      { id: 'r2-1', templateId: 'trooper', position: v2(384, 80) },
      { id: 'r2-2', templateId: 'trooper', position: v2(280, 120) },
      { id: 'r2-3', templateId: 'conscript', position: v2(488, 120) },
      { id: 'r2-4', templateId: 'conscript', position: v2(180, 100) },
    ],
    playerSpawnPositions: [
      v2(360, 660),
      v2(420, 660),
      v2(300, 660),
      v2(480, 660),
    ],
  },
  {
    id: 'extraction',
    displayName: '緊急撤離',
    description: '突破敵線,讓兩名以上隊員抵達北側撤離點。',
    mapId: MAP_ID,
    scenario: 'extract',
    scenarioParams: { extractCount: 2, extractRoundLimit: 8 },
    objectives: [
      {
        id: 'extract-objective',
        position: v2(680, 100),
        radius: 36,
        displayName: '撤離點',
      },
    ],
    enemyFaction: 'B',
    enemies: [
      { id: 'r3-1', templateId: 'heavy_gunner', position: v2(560, 280) },
      { id: 'r3-2', templateId: 'elite', position: v2(440, 240) },
      { id: 'r3-3', templateId: 'trooper', position: v2(620, 200) },
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
