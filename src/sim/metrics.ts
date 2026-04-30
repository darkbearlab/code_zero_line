import type { Faction } from '../core/state/GameState';
import type { MatchOutcome } from './runMatch';

export interface FactionKpi {
  readonly shotsTaken: number;
  readonly shotsHit: number;
  readonly hitRate: number;
  readonly reactionShotsTaken: number;
  readonly reactionShotsHit: number;
  readonly moveDistanceTotal: number;
  readonly rallyAttempts: number;
  readonly rallySuccess: number;
  readonly overdraftCount: number;
  readonly activationCheckFails: number;
  readonly unitsLost: number;
  readonly turnoversForcedByOpponent: number;
}

export interface MatchKpi {
  readonly winner: MatchOutcome['winner'];
  readonly cycles: number;
  readonly commandCount: number;
  readonly reason: MatchOutcome['reason'];
  readonly A: FactionKpi;
  readonly B: FactionKpi;
}

const emptyFaction = (): FactionKpi => ({
  shotsTaken: 0,
  shotsHit: 0,
  hitRate: 0,
  reactionShotsTaken: 0,
  reactionShotsHit: 0,
  moveDistanceTotal: 0,
  rallyAttempts: 0,
  rallySuccess: 0,
  overdraftCount: 0,
  activationCheckFails: 0,
  unitsLost: 0,
  turnoversForcedByOpponent: 0,
});

const findUnitFaction = (
  outcome: MatchOutcome,
  unitId: string,
): Faction | null => {
  const u = outcome.finalState.units.find((x) => x.id === unitId);
  return u?.faction ?? null;
};

type MutableKpi = { -readonly [K in keyof FactionKpi]: FactionKpi[K] };

const mutableEmpty = (): MutableKpi => ({ ...emptyFaction() });

/** Project a single match's events into per-faction KPIs. */
export const computeMatchKpi = (outcome: MatchOutcome): MatchKpi => {
  const a = mutableEmpty();
  const b = mutableEmpty();
  const bucket = (f: Faction): MutableKpi => (f === 'A' ? a : b);

  for (const ev of outcome.events) {
    switch (ev.type) {
      case 'SHOT_RESOLVED': {
        const f = findUnitFaction(outcome, ev.shooterId);
        if (!f) break;
        const k = bucket(f);
        k.shotsTaken += 1;
        if (ev.hits > 0) k.shotsHit += 1;
        if (ev.weaponMode === 'REACTION') {
          k.reactionShotsTaken += 1;
          if (ev.hits > 0) k.reactionShotsHit += 1;
        }
        if (ev.afterDamage === 'KILLED' && ev.beforeDamage !== 'KILLED') {
          // Target's faction loses a unit.
          const targetF = findUnitFaction(outcome, ev.targetId);
          if (targetF) bucket(targetF).unitsLost += 1;
        }
        break;
      }
      case 'MOVE_RESOLVED': {
        const f = findUnitFaction(outcome, ev.unitId);
        if (f) bucket(f).moveDistanceTotal += ev.distance;
        break;
      }
      case 'RALLY_ROLLED': {
        const f = findUnitFaction(outcome, ev.unitId);
        if (!f) break;
        const k = bucket(f);
        k.rallyAttempts += 1;
        if (ev.success) k.rallySuccess += 1;
        break;
      }
      case 'OVERDRAFT_DECLARED': {
        const f = findUnitFaction(outcome, ev.unitId);
        if (f) bucket(f).overdraftCount += 1;
        break;
      }
      case 'ACTIVATION_ENDED': {
        if (ev.reason === 'CHECK_FAILED') {
          const f = findUnitFaction(outcome, ev.unitId);
          if (f) bucket(f).activationCheckFails += 1;
        }
        break;
      }
      case 'INITIATIVE_TURNOVER': {
        if (ev.reason !== 'VOLUNTARY') {
          bucket(ev.from).turnoversForcedByOpponent += 1;
        }
        break;
      }
      case 'MELEE_RESOLVED': {
        const loserF = findUnitFaction(outcome, ev.loserId);
        if (loserF) bucket(loserF).unitsLost += 1;
        break;
      }
      default:
        break;
    }
  }

  a.hitRate = a.shotsTaken > 0 ? a.shotsHit / a.shotsTaken : 0;
  b.hitRate = b.shotsTaken > 0 ? b.shotsHit / b.shotsTaken : 0;

  return {
    winner: outcome.winner,
    cycles: outcome.cycles,
    commandCount: outcome.commandCount,
    reason: outcome.reason,
    A: a,
    B: b,
  };
};

export interface AggregateKpi {
  readonly matches: number;
  readonly winA: number;
  readonly winB: number;
  readonly draws: number;
  readonly winRateA: number;
  readonly winRateB: number;
  readonly avgCycles: number;
  readonly avgCommandCount: number;
  readonly endReasonCounts: Readonly<Record<string, number>>;
  readonly A: AggregateFactionKpi;
  readonly B: AggregateFactionKpi;
}

export interface AggregateFactionKpi {
  readonly shotsPerMatch: number;
  readonly hitRate: number;
  readonly reactionShotsPerMatch: number;
  readonly reactionHitRate: number;
  readonly moveDistancePerMatch: number;
  readonly rallyAttemptsPerMatch: number;
  readonly rallySuccessRate: number;
  readonly overdraftPerMatch: number;
  readonly activationCheckFailsPerMatch: number;
  readonly unitsLostPerMatch: number;
}

const aggregateFaction = (
  kpis: ReadonlyArray<MatchKpi>,
  side: 'A' | 'B',
): AggregateFactionKpi => {
  const n = Math.max(1, kpis.length);
  let shots = 0;
  let hits = 0;
  let reactionShots = 0;
  let reactionHits = 0;
  let moveDist = 0;
  let rallyAttempts = 0;
  let rallySuccess = 0;
  let overdrafts = 0;
  let checkFails = 0;
  let unitsLost = 0;
  for (const k of kpis) {
    const s = k[side];
    shots += s.shotsTaken;
    hits += s.shotsHit;
    reactionShots += s.reactionShotsTaken;
    reactionHits += s.reactionShotsHit;
    moveDist += s.moveDistanceTotal;
    rallyAttempts += s.rallyAttempts;
    rallySuccess += s.rallySuccess;
    overdrafts += s.overdraftCount;
    checkFails += s.activationCheckFails;
    unitsLost += s.unitsLost;
  }
  return {
    shotsPerMatch: shots / n,
    hitRate: shots > 0 ? hits / shots : 0,
    reactionShotsPerMatch: reactionShots / n,
    reactionHitRate: reactionShots > 0 ? reactionHits / reactionShots : 0,
    moveDistancePerMatch: moveDist / n,
    rallyAttemptsPerMatch: rallyAttempts / n,
    rallySuccessRate: rallyAttempts > 0 ? rallySuccess / rallyAttempts : 0,
    overdraftPerMatch: overdrafts / n,
    activationCheckFailsPerMatch: checkFails / n,
    unitsLostPerMatch: unitsLost / n,
  };
};

export const aggregateKpi = (
  outcomes: ReadonlyArray<MatchOutcome>,
): AggregateKpi => {
  const kpis = outcomes.map(computeMatchKpi);
  const winA = kpis.filter((k) => k.winner === 'A').length;
  const winB = kpis.filter((k) => k.winner === 'B').length;
  const draws = kpis.filter((k) => k.winner === 'DRAW').length;
  const reasonCounts: Record<string, number> = {};
  for (const k of kpis) {
    reasonCounts[k.reason] = (reasonCounts[k.reason] ?? 0) + 1;
  }
  const totalCycles = kpis.reduce((s, k) => s + k.cycles, 0);
  const totalCmds = kpis.reduce((s, k) => s + k.commandCount, 0);
  const n = Math.max(1, kpis.length);
  return {
    matches: kpis.length,
    winA,
    winB,
    draws,
    winRateA: winA / n,
    winRateB: winB / n,
    avgCycles: totalCycles / n,
    avgCommandCount: totalCmds / n,
    endReasonCounts: reasonCounts,
    A: aggregateFaction(kpis, 'A'),
    B: aggregateFaction(kpis, 'B'),
  };
};
