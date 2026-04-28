import Phaser from 'phaser';
import { D6_SIDES } from '../../core/rules/constants';
import { deriveRng } from '../../core/rng/sfc32';
import type { Faction } from '../../core/state/GameState';
import type { RostersBySide } from '../../core/setup/types';

interface InitData {
  rosters: RostersBySide;
  mapId?: string;
}

export class InitiativeRollScene extends Phaser.Scene {
  private rosters!: RostersBySide;
  private mapId?: string;
  private rootEl!: HTMLElement;
  private masterSeed = `match-${Date.now()}`;
  private rerollIndex = 0;

  constructor() {
    super({ key: 'InitiativeRoll' });
  }

  init(data: InitData): void {
    this.rosters = data.rosters;
    this.mapId = data.mapId;
  }

  create(): void {
    // Reset per scene entry (Phaser reuses scene instances).
    this.masterSeed = `match-${Date.now()}`;
    this.rerollIndex = 0;
    this.rootEl = this.makeRoot();
    this.events.once('shutdown', () => this.rootEl?.remove());
    this.runRoll();
  }

  private makeRoot(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'setup-root';
    root.innerHTML = `
      <h1>Initiative Roll</h1>
      <div class="setup-body" style="display:flex;align-items:center;justify-content:center;">
        <div style="display:flex;gap:48px;align-items:center;font-size:32px;">
          <div style="text-align:center;">
            <div style="color:#6ab0ff;font-size:14px;margin-bottom:8px;">Faction A</div>
            <div data-roll="A" style="width:80px;height:80px;display:flex;align-items:center;justify-content:center;background:#1a2a3a;border:2px solid #6ab0ff;">—</div>
          </div>
          <div style="font-size:18px;color:#7a9a7a;">vs</div>
          <div style="text-align:center;">
            <div style="color:#ff8a6a;font-size:14px;margin-bottom:8px;">Faction B</div>
            <div data-roll="B" style="width:80px;height:80px;display:flex;align-items:center;justify-content:center;background:#3a1a1a;border:2px solid #ff8a6a;">—</div>
          </div>
        </div>
      </div>
      <div class="setup-footer">
        <span data-result style="color:#7a9a7a;">Rolling...</span>
        <button data-action="continue" disabled style="margin-left:auto;">Continue →</button>
      </div>
    `;
    document.body.appendChild(root);
    return root;
  }

  private runRoll(): void {
    const rngA = deriveRng(this.masterSeed, this.rerollIndex, 'init:A');
    const rngB = deriveRng(this.masterSeed, this.rerollIndex, 'init:B');
    const rA = rngA.rollDie(D6_SIDES);
    const rB = rngB.rollDie(D6_SIDES);
    this.animateRoll('A', rA);
    this.animateRoll('B', rB);

    this.time.delayedCall(900, () => {
      if (rA === rB) {
        this.rerollIndex += 1;
        const result = this.rootEl.querySelector<HTMLElement>('[data-result]')!;
        result.textContent = `Tie (${rA} vs ${rB}) — re-rolling...`;
        this.time.delayedCall(600, () => this.runRoll());
        return;
      }
      const winner: Faction = rA > rB ? 'A' : 'B';
      const deployFirst: Faction = winner === 'A' ? 'B' : 'A';
      const result = this.rootEl.querySelector<HTMLElement>('[data-result]')!;
      result.innerHTML = `<strong style="color:${winner === 'A' ? '#6ab0ff' : '#ff8a6a'};">${winner}</strong> wins (${rA} vs ${rB}) — first holder. <strong>${deployFirst}</strong> deploys first.`;
      const cont =
        this.rootEl.querySelector<HTMLButtonElement>('[data-action="continue"]')!;
      cont.disabled = false;
      cont.onclick = () => {
        this.rootEl.remove();
        this.scene.start('Deploy', {
          rosters: this.rosters,
          firstHolder: winner,
          deployFirst,
          mapId: this.mapId,
        });
      };
    });
  }

  private animateRoll(faction: 'A' | 'B', finalValue: number): void {
    const cell = this.rootEl.querySelector<HTMLElement>(
      `[data-roll="${faction}"]`,
    )!;
    let ticks = 0;
    const tickEvent = this.time.addEvent({
      delay: 80,
      repeat: 8,
      callback: () => {
        ticks += 1;
        if (ticks > 8) {
          cell.textContent = String(finalValue);
          tickEvent.remove();
          return;
        }
        cell.textContent = String(1 + Math.floor(Math.random() * D6_SIDES));
      },
    });
  }
}
