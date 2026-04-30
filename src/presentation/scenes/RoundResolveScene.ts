/**
 * RoundResolveScene — design §4.1 戰役解決階段, the second half. After the
 * player's own run wraps in RunResultScene, this scene reveals the fates
 * of the round's unpicked options (rolled at commitOption time, stored
 * on RunState.unpickedOutcomes) and shows the currency delta.
 *
 * Campaign state is already advanced + saved by RunResultScene before
 * we get here; this scene is purely informational. Reloading mid-reveal
 * therefore lands cleanly on the next round's setup.
 */
import Phaser from 'phaser';
import { listUnitTemplates } from '../../config/loader';
import { getMissionById } from '../../missions/library';
import type { RunState } from '../../runs/state';
import type { CampaignState } from '../../campaign/state';

interface InitData {
  runState: RunState;
  prevCampaign: CampaignState;
  newCampaign: CampaignState;
}

export class RoundResolveScene extends Phaser.Scene {
  private rootEl!: HTMLElement;
  private runState!: RunState;
  private prevCampaign!: CampaignState;
  private newCampaign!: CampaignState;

  constructor() {
    super({ key: 'RoundResolve' });
  }

  init(data: InitData): void {
    this.runState = data.runState;
    this.prevCampaign = data.prevCampaign;
    this.newCampaign = data.newCampaign;
  }

  create(): void {
    hideBattleHud();
    this.rootEl = this.makeRoot();
    this.events.once('shutdown', () => this.rootEl?.remove());
  }

  private makeRoot(): HTMLElement {
    const tpls = listUnitTemplates();
    const tplName = (templateId: string): string =>
      tpls.find((t) => t.templateId === templateId)?.displayName ?? templateId;

    const memberLine = (id: string, survived: boolean): string => {
      const member = this.prevCampaign.pool.find((u) => u.id === id);
      const tplLabel = member ? tplName(member.templateId) : id;
      const color = survived ? '#9af09a' : '#ff8a8a';
      const bg = survived
        ? 'rgba(20,40,20,0.5)'
        : 'rgba(60,20,20,0.5)';
      const border = survived ? '#4a8a5a' : '#6a3a3a';
      const symbol = survived ? '✓' : '✗';
      const label = survived ? '生還' : 'KIA';
      return `
        <li style="padding:5px 10px;background:${bg};border:1px solid ${border};color:${color};display:flex;justify-content:space-between;font-size:11px;">
          <span>${symbol} ${id}</span>
          <span style="opacity:0.85;">${tplLabel} — ${label}</span>
        </li>
      `;
    };

    const unpicked = this.runState.unpickedOutcomes ?? [];
    const cardsHtml = unpicked.length === 0
      ? `<div style="color:#7a9a7a;font-style:italic;text-align:center;padding:24px;">本回合無其他可選任務。</div>`
      : unpicked
          .map((o) => {
            const mission = (() => {
              try {
                return getMissionById(o.missionId);
              } catch {
                return null;
              }
            })();
            const missionLabel = mission?.displayName ?? o.missionId;
            const headerColor = o.won ? '#9af09a' : '#ff8a6a';
            const headerLabel = o.won ? '✓ 任務成功' : '✗ 任務失敗';
            const intelLabel = o.won
              ? '<span style="color:#cfd1a1;">+3 區域情報</span>'
              : '<span style="color:#7a7a7a;">無獎勵</span>';

            const memberRows = o.squadIds
              .map((id) => memberLine(id, o.survivorIds.includes(id)))
              .join('');

            return `
              <div style="padding:12px 14px;background:rgba(20,30,20,0.55);border:1px solid #3a5a3a;display:flex;flex-direction:column;gap:8px;">
                <div style="display:flex;justify-content:space-between;align-items:baseline;">
                  <strong style="color:#cfe8cf;font-size:14px;">${missionLabel}</strong>
                  <span style="color:${headerColor};font-size:12px;">${headerLabel}</span>
                </div>
                <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px;">
                  ${memberRows}
                </ul>
                <div style="text-align:right;font-size:11px;">${intelLabel}</div>
              </div>
            `;
          })
          .join('');

    const prev = this.prevCampaign.currencies;
    const next = this.newCampaign.currencies;
    const fmtDelta = (n: number): string =>
      n === 0
        ? '<span style="color:#7a7a7a;">±0</span>'
        : n > 0
          ? `<span style="color:#9af09a;">+${n}</span>`
          : `<span style="color:#ff8a6a;">${n}</span>`;
    const dT = next.tactical - prev.tactical;
    const dR = next.regional - prev.regional;
    const dH = next.honor - prev.honor;

    const root = document.createElement('div');
    root.className = 'setup-root';
    root.innerHTML = `
      <h1>戰役解決階段</h1>
      <div class="setup-body" style="display:flex;flex-direction:column;gap:16px;">
        <div style="color:#7a9a7a;font-size:12px;text-align:center;">
          回合 ${this.prevCampaign.roundIndex} 結算 — 你沒接的任務
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;">
          ${cardsHtml}
        </div>
        <div style="margin-top:8px;padding:12px 14px;background:rgba(15,25,15,0.7);border:1px solid #2a3a2a;display:flex;justify-content:space-between;align-items:center;font-size:12px;">
          <div style="color:#9aa89a;">本回合貨幣變動</div>
          <div style="display:flex;gap:18px;">
            <span>作戰 ${fmtDelta(dT)} <span style="color:#7a9a7a;">(${next.tactical})</span></span>
            <span>區域 ${fmtDelta(dR)} <span style="color:#7a9a7a;">(${next.regional})</span></span>
            <span>榮譽 ${fmtDelta(dH)} <span style="color:#7a9a7a;">(${next.honor})</span></span>
          </div>
        </div>
      </div>
      <div class="setup-footer" style="justify-content:center;">
        <button data-action="continue" style="padding:10px 24px;background:#1a3a2a;color:#cfe8cf;border:1px solid #4a8a5a;cursor:pointer;font:inherit;">繼續下一回合 →</button>
      </div>
    `;
    document.body.appendChild(root);

    root.querySelector<HTMLButtonElement>('[data-action="continue"]')!.onclick =
      () => {
        this.rootEl.remove();
        this.scene.start('RoundSetup');
      };
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
