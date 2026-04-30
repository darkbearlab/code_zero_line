import { describe, it, expect } from 'vitest';
import {
  VETERAN_QUALITY_FLOOR,
  VETERAN_SORTIE_THRESHOLD,
  sortieQualityBonus,
  veteranAdjustedQuality,
} from './veteran';

describe('sortieQualityBonus', () => {
  it('zero sorties → no bonus', () => {
    expect(sortieQualityBonus(0)).toBe(0);
  });

  it('below threshold → no bonus', () => {
    expect(sortieQualityBonus(VETERAN_SORTIE_THRESHOLD - 1)).toBe(0);
  });

  it('exactly one threshold → +1', () => {
    expect(sortieQualityBonus(VETERAN_SORTIE_THRESHOLD)).toBe(1);
  });

  it('three thresholds → +3', () => {
    expect(sortieQualityBonus(VETERAN_SORTIE_THRESHOLD * 3)).toBe(3);
  });

  it('negative sorties (defensive) → 0', () => {
    expect(sortieQualityBonus(-5)).toBe(0);
  });
});

describe('veteranAdjustedQuality', () => {
  it('rookie (0 sorties) returns base quality unchanged', () => {
    expect(veteranAdjustedQuality(4, 0)).toBe(4);
  });

  it('one threshold reduces quality by 1', () => {
    expect(veteranAdjustedQuality(5, VETERAN_SORTIE_THRESHOLD)).toBe(4);
  });

  it('many sorties clamp at floor', () => {
    expect(veteranAdjustedQuality(5, VETERAN_SORTIE_THRESHOLD * 10)).toBe(
      VETERAN_QUALITY_FLOOR,
    );
  });

  it('officer already past floor stays put — auto-growth never makes them worse', () => {
    // squad_lead at q2 has zero room for auto-growth (already < floor).
    expect(veteranAdjustedQuality(2, VETERAN_SORTIE_THRESHOLD * 5)).toBe(2);
  });

  it('unit at floor gets no bonus', () => {
    expect(veteranAdjustedQuality(3, VETERAN_SORTIE_THRESHOLD)).toBe(3);
  });

  it('typical conscript path: q5 → q4 → q3 (capped)', () => {
    expect(veteranAdjustedQuality(5, VETERAN_SORTIE_THRESHOLD * 1)).toBe(4);
    expect(veteranAdjustedQuality(5, VETERAN_SORTIE_THRESHOLD * 2)).toBe(3);
    expect(veteranAdjustedQuality(5, VETERAN_SORTIE_THRESHOLD * 3)).toBe(3);
  });
});
