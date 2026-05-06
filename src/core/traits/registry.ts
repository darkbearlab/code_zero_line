import type { TraitDef } from './types';

/**
 * Central registry of unit traits. Each unit template's `traits: string[]`
 * is a list of IDs (optionally parameterized with `ID:N`) that resolve here.
 *
 * Implementation status:
 *   ✓ wired into the rules engine
 *   • declared but behavior pending
 */
export const TRAITS: Readonly<Record<string, TraitDef>> = {
  // ✓ Officer (rule 3.1) — handled directly by reducer/shoot_modes.
  OFFICER: {
    id: 'OFFICER',
    displayName: '軍官',
    description:
      '可指揮啟動 (1 UD 內友軍同行動)、聯合射擊發起者；1 UD 內友軍重整可借用素質。',
  },
  // ✓ Stalwart (rule 4.7 status penalty) — wired in melee dice computation.
  STALWART: {
    id: 'STALWART',
    displayName: '堅忍',
    description: '近戰時忽略受阻/壓制 -1 骰懲罰。',
    meleeIgnoresStatusPenalty: true,
  },
  // ✓ Fragile — wired in shooting damage application.
  FRAGILE: {
    id: 'FRAGILE',
    displayName: '脆弱',
    description: '受阻結果視為壓制。',
    fragileUpgrade: true,
  },
  // ✓ Armor(N) — wired in shooting hit absorption.
  ARMOR: {
    id: 'ARMOR',
    displayName: '裝甲',
    description: '在造成傷害之前，移除攻擊方 N 顆命中。',
    armorAbsorbHits: 'param',
  },
  // ✓ Cumbersome — wired in activation handlers (caps actionsRemaining to 1).
  CUMBERSOME: {
    id: 'CUMBERSOME',
    displayName: '笨重',
    description: '此單位每個主動權只能進行一個行動。',
    maxActionsPerActivation: 1,
  },
  // • Cannon Fodder (rule 7) — declared; turnover-suppression hook pending.
  // ✓ Cannon fodder — wired in reducer (`reactionOutcomeAfterFodder`).
  CANNON_FODDER: {
    id: 'CANNON_FODDER',
    displayName: '砲灰',
    description:
      '在自己的主動權中，這個單位被壓制或陣亡不會造成主動權易手。',
    cannonFodder: true,
  },
  // ✓ Fanatic — wired in resolveReactionPlan / resolveGroupReactionPlan
  // (IMPEDED-only reaction hits don't halt the path).
  FANATIC: {
    id: 'FANATIC',
    displayName: '狂熱',
    description: '不會因為受到「受阻」狀態而中斷行動。',
    fanaticIgnoresImpededInterrupt: true,
  },
  TOUGH: {
    id: 'TOUGH',
    displayName: '強韌',
    description:
      '一場遊戲一次，當在非壓制的情況下受到應致死的攻擊時，改為受到壓制。',
  },
  // ✓ Impulsive (rule 5) — variant-per-id design. Each variant ID encodes
  // both the shared trigger ("act on activation failure or before turnover
  // if not yet activated this round") and the variant-specific action.
  // Wired in src/core/commands/impulsive.ts + reducer activateCheck failure
  // branch + turnover() prelude.
  IMPULSIVE_AGGRESSIVE: {
    id: 'IMPULSIVE_AGGRESSIVE',
    displayName: '衝動（侵略）',
    description:
      '啟動檢定失敗或主動權易手時尚未行動 → 視線內有合法射擊目標則射擊期望命中最高者，否則朝最近敵人移動 1 UD（可繞 HARD 牆）。',
  },
  // • Agitator(N) (rule 7) — alternate activation cost from allies; pending.
  AGITATOR: {
    id: 'AGITATOR',
    displayName: '煽動',
    description: '1 單位距離內的我方單位可透過支付 N 點動能啟動此單位。',
    tbd: true,
  },
  // • Warlord (rule 7) — alt activation success path for Red faction; pending.
  WARLORD: {
    id: 'WARLORD',
    displayName: '督軍',
    description:
      '紅隊軍官啟動失敗 → 處決 1 UD 內視線中的「強徵兵」，該次啟動視為成功。',
    tbd: true,
  },
  // • Martyrdom (rule 7) — faction-level momentum reserve on fanatic death; pending.
  MARTYRDOM: {
    id: 'MARTYRDOM',
    displayName: '殉教',
    description:
      '民兵團「狂熱」單位陣亡 → 民兵團獲得 1 點動能儲備（不歸零）。',
    tbd: true,
  },
  STEALTH: {
    id: 'STEALTH',
    displayName: '隱身',
    description: '在同一個提供掩護的地形特徵內移動不會被反應射擊。',
  },
  // ✓ NO_PRONE — wired in reducer (CRAWL refusal, endProne stripping, post-command safeguard).
  NO_PRONE: {
    id: 'NO_PRONE',
    displayName: '無法趴下',
    description:
      '無法進入趴下姿態：不能匍匐、移動結束時不能改為趴下；任何原因進入趴下會在行動結束後立刻起立。',
    cannotProne: true,
  },
  // ✓ NO_CLIMB — wired in reducer (CLIMB refusal) + UI traversal context.
  NO_CLIMB: {
    id: 'NO_CLIMB',
    displayName: '無法攀爬',
    description: '無法進行攀爬行動。',
    cannotClimb: true,
  },
  // ✓ NO_VAULT — wired in reducer (VAULT refusal) + UI traversal context.
  NO_VAULT: {
    id: 'NO_VAULT',
    displayName: '無法翻越',
    description: '無法進行翻越行動。',
    cannotVault: true,
  },

  // ✓ DOOR_OPERATOR — wired in reducer (OPERATE_DOOR) + UI traversal context.
  DOOR_OPERATOR: {
    id: 'DOOR_OPERATOR',
    displayName: '開門許可',
    description: '可以開關門（OPERATE_DOOR 行動）。',
    canOperateDoor: true,
  },

  // ──────────────────────────────────────────────────────────────────
  // Category tags — pure classification, no inherent effect. Used by
  // outside systems (combat-intel meta, scenario gates, AI targeting
  // hooks) to decide who to apply rules TO. Add new categories here.
  // ──────────────────────────────────────────────────────────────────
  INFANTRY: {
    id: 'INFANTRY',
    displayName: '步兵',
    description: '輕裝徒步單位的分類標籤；無內建效果。',
    kind: 'category',
  },
  BEAST: {
    id: 'BEAST',
    displayName: '野獸',
    description: '生物型單位的分類標籤；無內建效果。',
    kind: 'category',
  },
  HEAVY: {
    id: 'HEAVY',
    displayName: '重裝',
    description: '攜帶重型裝備的分類標籤；無內建效果。',
    kind: 'category',
  },
  CYBORG: {
    id: 'CYBORG',
    displayName: '半機械',
    description: '機械強化單位的分類標籤；無內建效果。',
    kind: 'category',
  },
  MECH: {
    id: 'MECH',
    displayName: '機甲',
    description: '純機械單位的分類標籤；無內建效果。',
    kind: 'category',
  },
  COMMAND: {
    id: 'COMMAND',
    displayName: '指揮類',
    description: '高階指揮人員的分類標籤；無內建效果。',
    kind: 'category',
  },
};

export const getTraitDef = (id: string): TraitDef | undefined => TRAITS[id];

export const listTraits = (): ReadonlyArray<TraitDef> => Object.values(TRAITS);
