import type { GameState } from '../state/GameState';
import {
  ASSASSINATE_ACTIVATIONS_DEFAULT,
  DEFEND_ACTIVATIONS_DEFAULT,
  EXTRACT_ACTIVATIONS_DEFAULT,
  EXTRACT_COUNT_DEFAULT,
  WIN_LEAD_DEFAULT,
  WIN_SCORE_DEFAULT,
  factionAliveCount,
  factionUnitsOnObjective,
  type ScenarioMode,
  type ScenarioParams,
} from './victory';

export type ProgressTone = 'normal' | 'warn' | 'danger' | 'win';

export interface ScenarioProgress {
  readonly text: string;
  readonly tone: ProgressTone;
}

const remaining = (used: number, limit: number): number => Math.max(0, limit - used);

const clockTone = (left: number): ProgressTone => {
  if (left <= 0) return 'danger';
  if (left <= 2) return 'danger';
  if (left <= 4) return 'warn';
  return 'normal';
};

const ratioTone = (current: number, target: number): ProgressTone => {
  if (target <= 0) return 'normal';
  const ratio = current / target;
  if (ratio >= 1) return 'win';
  if (ratio >= 0.8) return 'warn';
  return 'normal';
};

export const formatScenarioProgress = (
  state: GameState,
  scenario: ScenarioMode,
  params: ScenarioParams,
  initialAlive: { A: number; B: number },
): ScenarioProgress => {
  const used = state.initiative.playerActivations;

  switch (scenario) {
    case 'elimination': {
      const a = factionAliveCount(state, 'A');
      const b = factionAliveCount(state, 'B');
      const killed = initialAlive.B - b;
      return {
        text: `殲滅:已擊倒 ${killed}/${initialAlive.B}(我方存 ${a}/${initialAlive.A})`,
        tone: ratioTone(killed, initialAlive.B),
      };
    }
    case 'engage-reach': {
      const aOnObj = factionUnitsOnObjective(state, 'A');
      const engaged = factionAliveCount(state, 'B') < initialAlive.B;
      if (aOnObj > 0 && engaged) {
        return { text: `接戰/抵達:已達標(我方 ${aOnObj} 上點·已交火)`, tone: 'win' };
      }
      const parts: string[] = [];
      parts.push(aOnObj > 0 ? `我方 ${aOnObj} 上點` : '尚未上點');
      parts.push(engaged ? '已交火' : '尚未交火');
      return {
        text: `接戰/抵達:${parts.join('·')}`,
        tone: aOnObj > 0 || engaged ? 'warn' : 'normal',
      };
    }
    case 'defend': {
      const limit = params.defendActivations ?? DEFEND_ACTIVATIONS_DEFAULT;
      const left = remaining(used, limit);
      const aOnObj = factionUnitsOnObjective(state, 'A');
      const bOnObj = factionUnitsOnObjective(state, 'B');
      if (bOnObj > 0) {
        return { text: `防守:敵 ${bOnObj} 已登上目標!`, tone: 'danger' };
      }
      return {
        text: `防守:倒數 ${left} 次啟動(我方 ${aOnObj} 守點)`,
        tone: clockTone(left),
      };
    }
    case 'extract': {
      const target = params.extractCount ?? EXTRACT_COUNT_DEFAULT;
      const limit = params.extractActivations ?? EXTRACT_ACTIVATIONS_DEFAULT;
      const left = remaining(used, limit);
      const onObj = factionUnitsOnObjective(state, 'A');
      const tone = onObj >= target ? 'win' : clockTone(left);
      return {
        text: `撤離:已撤 ${onObj}/${target}·倒數 ${left} 次啟動`,
        tone,
      };
    }
    case 'control-points': {
      const winScore = params.winScore ?? WIN_SCORE_DEFAULT;
      const winLead = params.winLead ?? WIN_LEAD_DEFAULT;
      const scores = state.initiative.objectiveScores ?? { A: 0, B: 0 };
      const leadA = scores.A - scores.B;
      let tone: ProgressTone = 'normal';
      if (scores.A >= winScore && leadA >= winLead) tone = 'win';
      else if (scores.B >= winScore && -leadA >= winLead) tone = 'danger';
      else if (scores.A >= winScore - 1 || scores.B >= winScore - 1) tone = 'warn';
      return {
        text: `控制點:A ${scores.A} vs B ${scores.B}(達 ${winScore} 分且領先 ${winLead} 勝)`,
        tone,
      };
    }
    case 'assassinate': {
      const limit = params.assassinateActivations ?? ASSASSINATE_ACTIVATIONS_DEFAULT;
      const left = remaining(used, limit);
      const vipId = params.vipUnitId;
      const vip = vipId ? state.units.find((u) => u.id === vipId) : undefined;
      if (vip && vip.damage === 'KILLED') {
        return { text: `斬首:目標 ${vipId} 已擊殺`, tone: 'win' };
      }
      const vipState = vip ? `${vipId}(${vip.damage})` : (vipId ?? '未指定');
      return {
        text: `斬首:目標 ${vipState}·倒數 ${left} 次啟動`,
        tone: clockTone(left),
      };
    }
  }
};
