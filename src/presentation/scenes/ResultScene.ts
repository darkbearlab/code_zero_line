import Phaser from 'phaser';
import { saveReplay } from '../../core/replay/storage';
import type { ReplayLog } from '../../core/replay/log';
import type { SideHealthCount } from './BattleScene';

interface InitData {
  winner: 'A' | 'B' | 'DRAW';
  counts: { A: SideHealthCount; B: SideHealthCount };
  finalRound: number;
  replayLog: ReplayLog;
}

export class ResultScene extends Phaser.Scene {
  private summary!: InitData;
  private rootEl!: HTMLElement;

  constructor() {
    super({ key: 'Result' });
  }

  init(data: InitData): void {
    this.summary = data;
  }

  create(): void {
    hideBattleHud();
    this.rootEl = this.makeRoot();
    this.events.once('shutdown', () => this.rootEl?.remove());
  }

  private makeRoot(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'setup-root';
    const winnerColor =
      this.summary.winner === 'A'
        ? '#6ab0ff'
        : this.summary.winner === 'B'
          ? '#ff8a6a'
          : '#cfe8cf';
    const winnerText =
      this.summary.winner === 'DRAW' ? 'DRAW' : `${this.summary.winner} WINS`;
    root.innerHTML = `
      <h1>Result</h1>
      <div class="setup-body" style="display:flex;flex-direction:column;gap:24px;">
        <div style="text-align:center;">
          <div style="font-size:36px;color:${winnerColor};letter-spacing:2px;">${winnerText}</div>
          <div style="margin-top:8px;font-size:13px;color:#7a9a7a;">Round ${this.summary.finalRound}</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:640px;margin:0 auto;width:100%;">
          ${this.renderSide('A')}
          ${this.renderSide('B')}
        </div>
      </div>
      <div class="setup-footer">
        <button data-action="save">Save Replay</button>
        <button data-action="rematch" style="margin-left:auto;">New Match (Roster)</button>
      </div>
    `;
    document.body.appendChild(root);
    root.querySelector<HTMLButtonElement>('[data-action="save"]')!.onclick =
      () => this.saveReplay();
    root.querySelector<HTMLButtonElement>('[data-action="rematch"]')!.onclick =
      () => {
        this.rootEl.remove();
        this.scene.start('Roster');
      };
    return root;
  }

  private renderSide(faction: 'A' | 'B'): string {
    const c = this.summary.counts[faction];
    const color = faction === 'A' ? '#6ab0ff' : '#ff8a6a';
    return `
      <div style="background:rgba(20,30,20,0.5);border:1px solid #2a3a2a;border-left:3px solid ${color};padding:12px 16px;">
        <h2 style="margin:0 0 8px;font-size:14px;color:${color};font-weight:normal;">Faction ${faction}</h2>
        <div style="display:flex;flex-direction:column;gap:4px;font-size:13px;">
          <div>Alive: <strong>${c.alive}</strong></div>
          <div>Suppressed: <strong>${c.suppressed}</strong></div>
          <div>Killed: <strong>${c.killed}</strong></div>
        </div>
      </div>
    `;
  }

  private saveReplay(): void {
    const id = saveReplay(this.summary.replayLog);
    const btn = this.rootEl.querySelector<HTMLButtonElement>(
      '[data-action="save"]',
    )!;
    btn.textContent = `Saved (${id})`;
    btn.disabled = true;
  }
}

const hideBattleHud = (): void => {
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';
  const frame = document.getElementById('hud-frame');
  if (frame) (frame as HTMLElement).style.display = 'none';
};
