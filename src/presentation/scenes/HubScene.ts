/**
 * HubScene — between-mission boon picker. The framing per design doc:
 * "squad members reporting in to the off-site commander" — the Hub
 * doesn't know what's ahead, so the boons are the squad's intel /
 * supply / tactical risk choices.
 *
 * v1 has 3 fixed boons (heal / +1 die / risk-reward). Phase 4 will
 * draw from a larger pool with weighted-random + scenario context.
 */
import Phaser from 'phaser';
import { applyBoon, type RunBoon, type RunState } from '../../runs/state';
import { getMissionById } from '../../missions/library';

interface InitData {
  runState: RunState;
}

const BOONS: ReadonlyArray<RunBoon> = [
  {
    id: 'heal-all',
    displayName: '醫療補給',
    description: '全隊治療,所有單位狀態重置為健康。',
    effect: { kind: 'HEAL_ALL' },
  },
  {
    id: 'bonus-dice',
    displayName: '彈藥支援',
    description: '本 run 剩下所有戰鬥,每名我方單位射擊 +1 dice。',
    effect: { kind: 'BONUS_DICE', amount: 1 },
  },
  {
    id: 'risk',
    displayName: '激進推進',
    description: '下一場敵方 +2 兵力,但你方武器 +2 dice (僅下一場)。',
    effect: { kind: 'NEXT_MISSION_HARDER', extraEnemies: 2, bonusDice: 2 },
  },
];

export class HubScene extends Phaser.Scene {
  private rootEl!: HTMLElement;
  private runState!: RunState;

  constructor() {
    super({ key: 'Hub' });
  }

  init(data: InitData): void {
    this.runState = data.runState;
  }

  create(): void {
    hideBattleHud();
    this.rootEl = this.makeRoot();
    this.events.once('shutdown', () => this.rootEl?.remove());
  }

  private makeRoot(): HTMLElement {
    const nextIdx = this.runState.missionIndex;
    const nextMissionId = this.runState.missionIds[nextIdx];
    const nextMission = nextMissionId ? getMissionById(nextMissionId) : null;
    const previousResult = this.runState.history[this.runState.history.length - 1];

    const survivorCount = this.runState.survivorIds.length;
    const fullCount = this.runState.squad.length;

    const cardsHtml = BOONS.map(
      (b) => `
      <button data-boon="${b.id}" style="
        flex:1;
        padding:18px;
        background:rgba(20,40,20,0.5);
        color:#cfe8cf;
        border:1px solid #4a8a5a;
        cursor:pointer;
        font:inherit;
        text-align:left;
        line-height:1.5;
        transition: background 0.15s;
      "
      onmouseover="this.style.background='rgba(40,80,40,0.6)'"
      onmouseout="this.style.background='rgba(20,40,20,0.5)'"
      >
        <div style="font-size:15px;font-weight:bold;color:#9af09a;margin-bottom:6px;">${b.displayName}</div>
        <div style="font-size:13px;color:#a8c8a8;">${b.description}</div>
      </button>
    `,
    ).join('');

    const flavorHtml = previousResult
      ? `<div style="color:#7a9a7a;font-style:italic;margin-bottom:12px;">「${previousResult.winner === 'A' ? '完成任務目標。生還' : '退守過程中折損'} ${survivorCount}/${fullCount} 人。」</div>`
      : '';

    const root = document.createElement('div');
    root.className = 'setup-root';
    root.innerHTML = `
      <h1>Hub — 前線回報</h1>
      <div class="setup-body" style="display:flex;flex-direction:column;gap:24px;align-items:center;">
        <div style="max-width:680px;text-align:center;">
          ${flavorHtml}
          <div style="color:#cfe8cf;font-size:14px;margin-bottom:6px;">
            <strong>下一場:</strong> 關 ${nextIdx + 1} ${nextMission ? `— ${nextMission.displayName}` : ''}
          </div>
          ${nextMission ? `<div style="color:#7a9a7a;font-size:13px;font-style:italic;">「${nextMission.description}」</div>` : ''}
        </div>
        <div style="display:flex;gap:14px;width:100%;max-width:900px;">
          ${cardsHtml}
        </div>
        <div style="color:#7a9a7a;font-size:12px;">選一個。boons 只在這次 run 內有效,結算後消失。</div>
      </div>
      <div class="setup-footer">
        <span style="color:#7a9a7a;font-size:12px;">
          已選 boons: ${this.runState.pickedBoons.length === 0 ? '(無)' : this.runState.pickedBoons.map((b) => b.displayName).join(', ')}
        </span>
      </div>
    `;
    document.body.appendChild(root);

    for (const b of BOONS) {
      root
        .querySelector<HTMLButtonElement>(`[data-boon="${b.id}"]`)!
        .addEventListener('click', () => {
          const next = applyBoon(this.runState, b);
          this.rootEl.remove();
          this.scene.start('Battle', { runState: next });
        });
    }
    return root;
  }
}

const hideBattleHud = (): void => {
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';
  const frame = document.getElementById('hud-frame');
  if (frame) (frame as HTMLElement).style.display = 'none';
  const glow = document.getElementById('hud-frame-glow');
  if (glow) (glow as HTMLElement).style.display = 'none';
};

