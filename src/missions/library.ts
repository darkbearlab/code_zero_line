/**
 * Hand-crafted mission set. Each scenario type has 1-2 variants so a run's
 * three mission picks can vary across plays. `pickMissions` (see ./pick.ts)
 * draws one mission per scenario type, then shuffles the order.
 *
 * Procedural generators + per-region weighting come in a later phase.
 */
import { v2 } from '../core/geometry/vec2';
import type { MissionDef } from './types';

const MAP_ID = 'demo';

export const MISSION_LIBRARY_V1: ReadonlyArray<MissionDef> = [
  // ── engage-reach ────────────────────────────────────────────────────
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
    id: 'breakthrough',
    displayName: '突破前線',
    description: '從正面碾過敵陣,搶下西側中繼點。',
    mapId: MAP_ID,
    scenario: 'engage-reach',
    objectives: [
      {
        id: 'breakthrough-objective',
        position: v2(160, 280),
        radius: 36,
        displayName: '中繼點',
      },
    ],
    enemyFaction: 'B',
    enemies: [
      { id: 'br1', templateId: 'trooper', position: v2(220, 220) },
      { id: 'br2', templateId: 'trooper', position: v2(540, 220) },
      { id: 'br3', templateId: 'conscript', position: v2(380, 100) },
    ],
    playerSpawnPositions: [
      v2(115, 652),
      v2(168, 599),
      v2(80, 700),
      v2(200, 660),
    ],
  },

  // ── defend ──────────────────────────────────────────────────────────
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
    id: 'last-stand',
    displayName: '最後死守',
    description: '更短時間、更猛攻勢 — 撐住 4 回合就收工。',
    mapId: MAP_ID,
    scenario: 'defend',
    scenarioParams: { defendRounds: 4 },
    objectives: [
      {
        id: 'lstand-objective',
        position: v2(384, 580),
        radius: 36,
        displayName: '指揮所',
      },
    ],
    enemyFaction: 'B',
    enemies: [
      { id: 'ls-1', templateId: 'heavy_gunner', position: v2(384, 80) },
      { id: 'ls-2', templateId: 'trooper', position: v2(240, 120) },
      { id: 'ls-3', templateId: 'trooper', position: v2(528, 120) },
      { id: 'ls-4', templateId: 'elite', position: v2(360, 200) },
      { id: 'ls-5', templateId: 'conscript', position: v2(440, 200) },
    ],
    playerSpawnPositions: [
      v2(360, 660),
      v2(420, 660),
      v2(300, 660),
      v2(480, 660),
    ],
  },

  // ── extract ─────────────────────────────────────────────────────────
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
  {
    id: 'night-extraction',
    displayName: '夜間撤離',
    description: '左翼煙幕掩護,兩人抵達西側陰影下的撤離點。',
    mapId: MAP_ID,
    scenario: 'extract',
    scenarioParams: { extractCount: 2, extractRoundLimit: 9 },
    objectives: [
      {
        id: 'night-extract-objective',
        position: v2(96, 100),
        radius: 36,
        displayName: '撤離點',
      },
    ],
    enemyFaction: 'B',
    enemies: [
      { id: 'ne-1', templateId: 'trooper', position: v2(180, 240) },
      { id: 'ne-2', templateId: 'conscript', position: v2(320, 200) },
    ],
    playerSpawnPositions: [
      v2(560, 660),
      v2(620, 660),
      v2(500, 700),
      v2(680, 700),
    ],
  },

  // ── assassinate ─────────────────────────────────────────────────────
  {
    id: 'decapitation',
    displayName: '斬首行動',
    description: '幹掉敵方指揮官 — 其他人怎樣都好。',
    mapId: MAP_ID,
    scenario: 'assassinate',
    scenarioParams: { vipUnitId: 'vip-1', assassinateRoundLimit: 8 },
    objectives: [],
    enemyFaction: 'B',
    enemies: [
      { id: 'vip-1', templateId: 'squad_lead', position: v2(384, 100) },
      { id: 'gd-1', templateId: 'trooper', position: v2(240, 120) },
      { id: 'gd-2', templateId: 'trooper', position: v2(528, 120) },
      { id: 'gd-3', templateId: 'conscript', position: v2(150, 80) },
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
