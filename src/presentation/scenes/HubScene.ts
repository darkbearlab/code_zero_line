/**
 * HubScene — between-mission boon picker. The framing per design doc:
 * "squad members reporting in to the off-site commander" — the Hub
 * doesn't know what's ahead, so the boons are the squad's intel /
 * supply / tactical risk choices.
 *
 * Stage 3 adds operation context: when a multi-stage operation is in
 * flight, the hub shows banked rewards + a Retreat button. Picking a
 * boon still routes into the next mission; Retreat skips remaining
 * stages, banks what's been earned, and routes to RunResult with the
 * RETREATED outcome.
 */
import Phaser from 'phaser';
import {
  applyBoon,
  retreatOperation,
  type RunBoon,
  type RunState,
} from '../../runs/state';
import { saveRun } from '../../runs/persist';
import { nextMissionNeedsDeployScene } from '../../runs/launchMission';
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

    // Operation banner (banked rewards + stage progress) only for in-flight
    // multi-stage operations. Sandbox / single-mission flows skip the banner
    // so the hub still reads cleanly.
    const op = this.runState.operation;
    const banked = this.runState.bankedRewards;
    const opBanner = op
      ? `
        <div style="margin-bottom:12px;padding:10px 14px;background:rgba(20,30,40,0.6);border:1px solid #4a6a8a;display:flex;justify-content:space-between;align-items:center;font-size:12px;">
          <div style="color:#a1a1cf;">行動 ${op.operationId} — 階段 ${nextIdx + 1} / ${this.runState.missionIds.length}</div>
          <div style="color:#cfd1a1;">已入袋 作戰 ${banked?.tactical ?? 0} · 區域 ${banked?.regional ?? 0} · 榮譽 ${banked?.honor ?? 0}</div>
        </div>
      `
      : '';
    const retreatBtn = op
      ? `<button data-action="retreat" style="padding:6px 14px;background:#3a1a1a;color:#cfa8a8;border:1px solid #6a3a3a;cursor:pointer;font:inherit;">撤退 (保留階段獎)</button>`
      : '';

    const root = document.createElement('div');
    root.className = 'setup-root';
    root.innerHTML = `
      <h1>Hub — 前線回報</h1>
      <div class="setup-body" style="display:flex;flex-direction:column;gap:24px;align-items:center;">
        <div style="max-width:680px;text-align:center;width:100%;">
          ${opBanner}
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
        ${retreatBtn ? `<span style="margin-left:auto;">${retreatBtn}</span>` : ''}
      </div>
    `;
    document.body.appendChild(root);

    for (const b of BOONS) {
      root
        .querySelector<HTMLButtonElement>(`[data-boon="${b.id}"]`)!
        .addEventListener('click', () => {
          const next = applyBoon(this.runState, b);
          if (next.inCampaign) saveRun(next);
          this.rootEl.remove();
          if (nextMissionNeedsDeployScene(next)) {
            this.scene.start('Deploy', { runState: next });
          } else {
            this.scene.start('Battle', { runState: next });
          }
        });
    }

    const retreatEl = root.querySelector<HTMLButtonElement>(
      '[data-action="retreat"]',
    );
    if (retreatEl) {
      retreatEl.onclick = () => {
        if (
          !confirm(
            '撤退會結束本行動,保留已入袋階段獎(放棄完成獎),所有單位安全歸隊。確定?',
          )
        )
          return;
        const next = retreatOperation(this.runState);
        if (next.inCampaign) saveRun(next);
        this.rootEl.remove();
        this.scene.start('RunResult', { runState: next });
      };
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
