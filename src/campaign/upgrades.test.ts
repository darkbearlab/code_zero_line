import { describe, it, expect } from 'vitest';
import {
  buildCombatIntelFromUpgrades,
  initialMomentumBonus,
  poolQualityBonus,
  UPGRADE_REGISTRY,
  upgradeMaxLevel,
  upgradeNextCost,
  getUpgradeById,
} from './upgrades';
import {
  buyUpgrade,
  exchangeRegionalForTactical,
  newCampaignState,
  REGIONAL_TO_TACTICAL_RATE,
} from './state';

describe('UPGRADE_REGISTRY', () => {
  it('has unique ids', () => {
    const ids = UPGRADE_REGISTRY.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('every upgrade has at least 1 level', () => {
    for (const u of UPGRADE_REGISTRY) {
      expect(u.costPerLevel.length).toBeGreaterThan(0);
    }
  });
});

describe('upgradeNextCost', () => {
  const def = UPGRADE_REGISTRY[0]!;
  it('returns first cost at level 0', () => {
    expect(upgradeNextCost(def, 0)).toBe(def.costPerLevel[0]);
  });
  it('returns null at max level', () => {
    expect(upgradeNextCost(def, upgradeMaxLevel(def))).toBeNull();
  });
});

describe('buildCombatIntelFromUpgrades', () => {
  it('empty levels → empty tracks', () => {
    const out = buildCombatIntelFromUpgrades({});
    expect(out.shoot).toEqual({});
    expect(out.melee).toEqual({});
  });
  it('shoot upgrades populate shoot track by tag, summed', () => {
    const out = buildCombatIntelFromUpgrades({
      anti_infantry: 2,
      anti_heavy: 1,
    });
    expect(out.shoot).toEqual({ INFANTRY: 2, HEAVY: 1 });
    expect(out.melee).toEqual({});
  });
  it('melee upgrades go to melee track', () => {
    const out = buildCombatIntelFromUpgrades({ melee_training: 3 });
    expect(out.melee).toEqual({ INFANTRY: 3 });
    expect(out.shoot).toEqual({});
  });
});

describe('poolQualityBonus / initialMomentumBonus', () => {
  it('reads pool_quality level', () => {
    expect(poolQualityBonus({})).toBe(0);
    expect(poolQualityBonus({ pool_quality: 2 })).toBe(2);
  });
  it('reads field_supply level', () => {
    expect(initialMomentumBonus({})).toBe(0);
    expect(initialMomentumBonus({ field_supply: 3 })).toBe(3);
  });
});

describe('buyUpgrade', () => {
  it('deducts cost + bumps level when affordable', () => {
    const c = newCampaignState('seed-buy');
    const def = getUpgradeById('anti_infantry')!;
    const cost = def.costPerLevel[0]!;
    const wallet = { ...c, currencies: { ...c.currencies, tactical: cost + 5 } };
    const after = buyUpgrade(wallet, def);
    expect(after).not.toBeNull();
    expect(after!.upgradeLevels[def.id]).toBe(1);
    expect(after!.currencies.tactical).toBe(5);
  });

  it('returns null when underfunded', () => {
    const c = newCampaignState('seed-poor');
    const def = getUpgradeById('anti_infantry')!;
    expect(buyUpgrade(c, def)).toBeNull();
  });

  it('returns null when maxed', () => {
    const c = newCampaignState('seed-max');
    const def = getUpgradeById('anti_infantry')!;
    const max = upgradeMaxLevel(def);
    const maxed = {
      ...c,
      currencies: { ...c.currencies, tactical: 1000 },
      upgradeLevels: { [def.id]: max },
    };
    expect(buyUpgrade(maxed, def)).toBeNull();
  });
});

describe('exchangeRegionalForTactical', () => {
  it('converts at the published rate', () => {
    const c = newCampaignState('seed-exch');
    const wallet = {
      ...c,
      currencies: { tactical: 0, regional: REGIONAL_TO_TACTICAL_RATE, honor: 0 },
    };
    const after = exchangeRegionalForTactical(wallet);
    expect(after).not.toBeNull();
    expect(after!.currencies.tactical).toBe(1);
    expect(after!.currencies.regional).toBe(0);
  });

  it('returns null below the rate', () => {
    const c = newCampaignState('seed-exch-poor');
    const wallet = {
      ...c,
      currencies: { tactical: 0, regional: REGIONAL_TO_TACTICAL_RATE - 1, honor: 0 },
    };
    expect(exchangeRegionalForTactical(wallet)).toBeNull();
  });
});
