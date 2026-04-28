import type { Weapon } from '../core/state/GameState';
import type { UnitTemplate } from '../config/loader';

const WEAPON_KEY = 'czl.editor.weapons.v1';
const TEMPLATE_KEY = 'czl.editor.templates.v1';

export interface CustomWeapon extends Weapon {
  /** Marker so future editor versions can migrate. */
  readonly _custom?: true;
}

export interface CustomTemplate extends UnitTemplate {
  readonly _custom?: true;
}

const safeParse = <T>(raw: string | null): T[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

export const loadCustomWeapons = (): CustomWeapon[] =>
  safeParse<CustomWeapon>(localStorage.getItem(WEAPON_KEY));

export const saveCustomWeapons = (list: ReadonlyArray<CustomWeapon>): void => {
  localStorage.setItem(WEAPON_KEY, JSON.stringify(list));
};

export const loadCustomTemplates = (): CustomTemplate[] =>
  safeParse<CustomTemplate>(localStorage.getItem(TEMPLATE_KEY));

export const saveCustomTemplates = (
  list: ReadonlyArray<CustomTemplate>,
): void => {
  localStorage.setItem(TEMPLATE_KEY, JSON.stringify(list));
};

export const upsertCustomWeapon = (w: CustomWeapon): void => {
  const list = loadCustomWeapons().filter((x) => x.id !== w.id);
  list.push({ ...w, _custom: true });
  saveCustomWeapons(list);
};

export const removeCustomWeapon = (id: string): void => {
  saveCustomWeapons(loadCustomWeapons().filter((w) => w.id !== id));
};

export const upsertCustomTemplate = (t: CustomTemplate): void => {
  const list = loadCustomTemplates().filter((x) => x.templateId !== t.templateId);
  list.push({ ...t, _custom: true });
  saveCustomTemplates(list);
};

export const removeCustomTemplate = (templateId: string): void => {
  saveCustomTemplates(
    loadCustomTemplates().filter((t) => t.templateId !== templateId),
  );
};

export const resetAllCustomData = (): void => {
  localStorage.removeItem(WEAPON_KEY);
  localStorage.removeItem(TEMPLATE_KEY);
};
