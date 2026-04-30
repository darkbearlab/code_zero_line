import { describe, it, expect } from 'vitest';
import { classifyFuzzy, fuzzyToRates } from './fuzzy';
import type { MissionDef } from '../missions/types';
import type { RosterEntry } from '../core/setup/types';

const enemy = (
  templateId: string,
  i: number,
): MissionDef['enemies'][number] => ({
  id: `e-${i}`,
  templateId,
  position: { x: 0, y: 0 },
});

const buildMission = (
  enemyTemplates: ReadonlyArray<string>,
): MissionDef => ({
  id: 'test-mission',
  displayName: 'Test',
  description: '',
  mapId: 'demo',
  scenario: 'engage-reach',
  enemyFaction: 'B',
  enemies: enemyTemplates.map((t, i) => enemy(t, i)),
  playerSpawnPositions: [{ x: 0, y: 0 }],
});

const r = (id: string, templateId: string): RosterEntry => ({
  id,
  templateId,
});

describe('fuzzyToRates', () => {
  it('low risk = ~85%/85%', () => {
    expect(fuzzyToRates('low')).toEqual({
      successRate: 0.85,
      survivalRate: 0.85,
    });
  });
  it('medium = 70%/70% (back-compat with prior placeholder)', () => {
    expect(fuzzyToRates('medium')).toEqual({
      successRate: 0.7,
      survivalRate: 0.7,
    });
  });
  it('high risk drops both rates noticeably', () => {
    const rates = fuzzyToRates('high');
    expect(rates.successRate).toBeLessThan(0.7);
    expect(rates.survivalRate).toBeLessThan(0.7);
  });
});

describe('classifyFuzzy', () => {
  it('strong squad vs weak enemies → low', () => {
    // squad: 4 squad_lead (q2 → strength 5 ea = 20)
    // enemies: 1 conscript (q4 → 3) → ratio 6.66
    const pool = [
      r('p1', 'squad_lead'),
      r('p2', 'squad_lead'),
      r('p3', 'squad_lead'),
      r('p4', 'squad_lead'),
    ];
    const mission = buildMission(['conscript']);
    expect(classifyFuzzy(mission, pool.map((p) => p.id), pool)).toBe('low');
  });

  it('weak squad vs heavy enemies → high', () => {
    // squad: 4 conscript (q4 → 3 ea = 12)
    // enemies: heavy_gunner ×2 (q3 → 4×2=8) + elite ×3 (q2 → 5×3=15) = 23 → ratio 0.52
    const pool = [
      r('p1', 'conscript'),
      r('p2', 'conscript'),
      r('p3', 'conscript'),
      r('p4', 'conscript'),
    ];
    const mission = buildMission([
      'heavy_gunner',
      'heavy_gunner',
      'elite',
      'elite',
      'elite',
    ]);
    expect(classifyFuzzy(mission, pool.map((p) => p.id), pool)).toBe('high');
  });

  it('roughly balanced → medium', () => {
    // squad: 2 trooper + 2 conscript = 4+4+3+3 = 14
    // enemies: 2 trooper + 2 conscript = 14 → ratio 1.0
    const pool = [
      r('p1', 'trooper'),
      r('p2', 'trooper'),
      r('p3', 'conscript'),
      r('p4', 'conscript'),
    ];
    const mission = buildMission(['trooper', 'trooper', 'conscript', 'conscript']);
    expect(classifyFuzzy(mission, pool.map((p) => p.id), pool)).toBe('medium');
  });

  it('zero enemies → low (defensive)', () => {
    const pool = [r('p1', 'trooper')];
    const mission = buildMission([]);
    expect(classifyFuzzy(mission, ['p1'], pool)).toBe('low');
  });

  it('squad members not in pool contribute zero strength', () => {
    // squad ids reference one missing entry → strength counts only the present one.
    // 1 trooper (q3 → 4) vs 4 trooper (q3 → 16) = ratio 0.25 → high
    const pool = [r('p1', 'trooper')];
    const mission = buildMission(['trooper', 'trooper', 'trooper', 'trooper']);
    expect(classifyFuzzy(mission, ['p1', 'ghost'], pool)).toBe('high');
  });
});
