import { describe, it, expect } from 'vitest';
import { applyHits, isMoreSevereThan } from './damage';

describe('applyHits damage ladder', () => {
  it('NONE + 1 hit → IMPEDED', () => {
    expect(applyHits('NONE', 1)).toBe('IMPEDED');
  });
  it('NONE + 2 hits → SUPPRESSED', () => {
    expect(applyHits('NONE', 2)).toBe('SUPPRESSED');
  });
  it('NONE + 3 hits → KILLED', () => {
    expect(applyHits('NONE', 3)).toBe('KILLED');
  });
  it('IMPEDED + 1 hit → SUPPRESSED', () => {
    expect(applyHits('IMPEDED', 1)).toBe('SUPPRESSED');
  });
  it('IMPEDED + 2 hits → KILLED', () => {
    expect(applyHits('IMPEDED', 2)).toBe('KILLED');
  });
  it('SUPPRESSED + 1 hit → KILLED', () => {
    expect(applyHits('SUPPRESSED', 1)).toBe('KILLED');
  });
  it('overkill caps at KILLED', () => {
    expect(applyHits('NONE', 99)).toBe('KILLED');
    expect(applyHits('SUPPRESSED', 99)).toBe('KILLED');
  });
  it('zero hits leaves state unchanged', () => {
    expect(applyHits('NONE', 0)).toBe('NONE');
    expect(applyHits('IMPEDED', 0)).toBe('IMPEDED');
  });
});

describe('isMoreSevereThan', () => {
  it('orders the ladder correctly', () => {
    expect(isMoreSevereThan('IMPEDED', 'NONE')).toBe(true);
    expect(isMoreSevereThan('SUPPRESSED', 'IMPEDED')).toBe(true);
    expect(isMoreSevereThan('KILLED', 'SUPPRESSED')).toBe(true);
    expect(isMoreSevereThan('NONE', 'IMPEDED')).toBe(false);
    expect(isMoreSevereThan('IMPEDED', 'IMPEDED')).toBe(false);
  });
});
