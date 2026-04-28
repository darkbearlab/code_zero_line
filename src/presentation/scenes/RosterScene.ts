import Phaser from 'phaser';
import { listUnitTemplates } from '../../config/loader';
import {
  ROSTER_MAX_PER_SIDE,
  ROSTER_MIN_PER_SIDE,
  type RosterEntry,
  type RostersBySide,
} from '../../core/setup/types';

const FACTIONS: ReadonlyArray<'A' | 'B'> = ['A', 'B'];

const FACTION_LABEL: Readonly<Record<'A' | 'B', string>> = {
  A: 'Faction A (Blue)',
  B: 'Faction B (Red)',
};

export class RosterScene extends Phaser.Scene {
  private rosters: { A: RosterEntry[]; B: RosterEntry[] } = { A: [], B: [] };
  private nextIdCounter = 0;
  private rootEl!: HTMLElement;

  constructor() {
    super({ key: 'Roster' });
  }

  create(): void {
    // Reset per scene entry (Phaser reuses scene instances).
    this.rosters = { A: [], B: [] };
    this.nextIdCounter = 0;
    hideBattleHud();
    this.rootEl = this.makeRoot();
    this.events.once('shutdown', () => this.rootEl?.remove());
    this.refresh();
  }

  private makeRoot(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'setup-root';
    root.innerHTML = `
      <h1>Code: Zero Line — Roster</h1>
      <div class="setup-body">
        <div class="roster-grid">
          <div class="roster-side faction-A" data-side="A">
            <h2>${FACTION_LABEL.A} <span class="roster-count" data-count="A"></span></h2>
            <div class="roster-list" data-list="A"></div>
            <div class="roster-add" data-add="A"></div>
          </div>
          <div class="roster-side faction-B" data-side="B">
            <h2>${FACTION_LABEL.B} <span class="roster-count" data-count="B"></span></h2>
            <div class="roster-list" data-list="B"></div>
            <div class="roster-add" data-add="B"></div>
          </div>
        </div>
      </div>
      <div class="setup-footer">
        <button data-action="demo">Demo loadout (2v2)</button>
        <button data-action="replay">Play last replay</button>
        <button data-action="continue" style="margin-left:auto;">Continue →</button>
      </div>
    `;
    document.body.appendChild(root);

    root.querySelector<HTMLButtonElement>('[data-action="demo"]')!.onclick =
      () => this.fillDemoLoadout();
    root.querySelector<HTMLButtonElement>('[data-action="replay"]')!.onclick =
      () => {
        this.rootEl.remove();
        this.scene.start('Replay');
      };
    root.querySelector<HTMLButtonElement>('[data-action="continue"]')!.onclick =
      () => this.tryContinue();

    return root;
  }

  private refresh(): void {
    for (const f of FACTIONS) {
      this.refreshSide(f);
    }
    const cont = this.rootEl.querySelector<HTMLButtonElement>(
      '[data-action="continue"]',
    )!;
    cont.disabled = !this.bothSidesValid();
  }

  private refreshSide(faction: 'A' | 'B'): void {
    const list = this.rootEl.querySelector<HTMLElement>(
      `[data-list="${faction}"]`,
    )!;
    const addEl = this.rootEl.querySelector<HTMLElement>(
      `[data-add="${faction}"]`,
    )!;
    const countEl = this.rootEl.querySelector<HTMLElement>(
      `[data-count="${faction}"]`,
    )!;
    const entries = this.rosters[faction];
    list.innerHTML = '';
    for (const e of entries) {
      const tpl = listUnitTemplates().find((t) => t.templateId === e.templateId);
      const row = document.createElement('div');
      row.className = 'roster-item';
      row.innerHTML = `
        <span>${e.id} — <strong>${tpl?.displayName ?? e.templateId}</strong> (q${tpl?.quality ?? '?'}+)</span>
        <button data-remove="${e.id}">×</button>
      `;
      row.querySelector<HTMLButtonElement>(`[data-remove="${e.id}"]`)!.onclick =
        () => {
          this.rosters[faction] = this.rosters[faction].filter(
            (x) => x.id !== e.id,
          );
          this.refresh();
        };
      list.appendChild(row);
    }

    addEl.innerHTML = '';
    if (entries.length < ROSTER_MAX_PER_SIDE) {
      const select = document.createElement('select');
      for (const tpl of listUnitTemplates()) {
        const opt = document.createElement('option');
        opt.value = tpl.templateId;
        opt.textContent = `${tpl.displayName} (q${tpl.quality}+, ${tpl.weaponIds.join(', ')})`;
        select.appendChild(opt);
      }
      const btn = document.createElement('button');
      btn.textContent = '+ Add';
      btn.onclick = () => {
        this.rosters[faction] = [
          ...this.rosters[faction],
          this.makeEntry(faction, select.value),
        ];
        this.refresh();
      };
      addEl.appendChild(select);
      addEl.appendChild(btn);
    } else {
      const note = document.createElement('span');
      note.style.color = '#7a9a7a';
      note.style.fontSize = '12px';
      note.textContent = `(max ${ROSTER_MAX_PER_SIDE} reached)`;
      addEl.appendChild(note);
    }

    const valid = this.sideValid(faction);
    countEl.textContent = `${entries.length}/${ROSTER_MAX_PER_SIDE} ${valid ? '✓' : `(min ${ROSTER_MIN_PER_SIDE})`}`;
    countEl.style.color = valid ? '#9af09a' : '#ffae6a';
  }

  private makeEntry(faction: 'A' | 'B', templateId: string): RosterEntry {
    const prefix = faction === 'A' ? 'blue' : 'red';
    this.nextIdCounter += 1;
    return { id: `${prefix}-${this.nextIdCounter}`, templateId };
  }

  private sideValid(faction: 'A' | 'B'): boolean {
    const n = this.rosters[faction].length;
    return n >= ROSTER_MIN_PER_SIDE && n <= ROSTER_MAX_PER_SIDE;
  }

  private bothSidesValid(): boolean {
    return this.sideValid('A') && this.sideValid('B');
  }

  private fillDemoLoadout(): void {
    this.rosters = { A: [], B: [] };
    this.nextIdCounter = 0;
    this.rosters.A = [
      this.makeEntry('A', 'elite'),
      this.makeEntry('A', 'trooper'),
    ];
    this.rosters.B = [
      this.makeEntry('B', 'conscript'),
      this.makeEntry('B', 'heavy_gunner'),
    ];
    this.refresh();
  }

  private tryContinue(): void {
    if (!this.bothSidesValid()) return;
    const rosters: RostersBySide = {
      A: [...this.rosters.A],
      B: [...this.rosters.B],
    };
    this.rootEl.remove();
    this.scene.start('InitiativeRoll', { rosters });
  }
}

const hideBattleHud = (): void => {
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';
  const frame = document.getElementById('hud-frame');
  if (frame) (frame as HTMLElement).style.display = 'none';
};
