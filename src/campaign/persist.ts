/**
 * localStorage persistence for CampaignState. Single-slot save under
 * `czl.campaign.v1`. Phase 3a uses the SSR-safe pattern (try/catch +
 * `typeof window`) so unit tests + headless sims never trip on a missing
 * window object.
 *
 * Migrations: when the shape changes, bump CampaignState.version and
 * either migrate old saves or reject them by returning null.
 */
import type { CampaignState } from './state';

const STORAGE_KEY = 'czl.campaign.v1';

const hasLocalStorage = (): boolean => {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
};

export const saveCampaign = (s: CampaignState): void => {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Quota / private browsing — silently drop. Surface in 3b if needed.
  }
};

export const loadCampaign = (): CampaignState | null => {
  if (!hasLocalStorage()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CampaignState>;
    if (parsed && parsed.version === 1) {
      return parsed as CampaignState;
    }
    return null;
  } catch {
    return null;
  }
};

export const clearCampaign = (): void => {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
};

export const hasSavedCampaign = (): boolean => loadCampaign() !== null;
