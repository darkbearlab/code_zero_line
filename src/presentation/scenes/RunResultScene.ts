/**
 * RunResultScene — end-of-run summary. Shows whether the run was a
 * success (all 3 missions cleared with at least one survivor) or a
 * failure (squad wiped before mission 3 finished). Phase 3 will
 * extend this with currency rewards, persistent pool updates, and
 * sortie-count bumps. v1 just shows the outline.
 */
import Phaser from 'phaser';
import { listUnitTemplates } from '../../config/loader';
import { didRunSucceed, type RunState } from '../../runs/state';
import {
  advanceCampaignAfterRun,
  type CampaignState,
  type RunResolution,
} from '../../campaign/state';
import { loadCampaign, saveCampaign } from '../../campaign/persist';

interface InitData {
  runState: RunState;
}

export class RunResultScene extends Phaser.Scene {
  private rootEl!: HTMLElement;
  private runState!: RunState;
  /** Campaign snapshot pre/post advance, handed to RoundResolveScene. */
  private prevCampaign: CampaignState | null = null;
  private newCampaign: CampaignState | null = null;

  constructor() {
    super({ key: 'RunResult' });
  }

  init(data: InitData): void {
    this.runState = data.runState;
    this.prevCampaign = null;
    this.newCampaign = null;
  }

  create(): void {
    hideBattleHud();
    // Campaign-mode runs commit their outcome to CampaignState here
    // (RunResultScene is the deterministic last touch-point before the
    // next round). Sandbox runs skip this entirely.
    if (this.runState.inCampaign) this.applyCampaignOutcome();
    this.rootEl = this.makeRoot();
    this.events.once('shutdown', () => this.rootEl?.remove());
  }

  private applyCampaignOutcome(): void {
    const campaign = loadCampaign();
    if (!campaign) return; // Campaign got cleared mid-run; bail.
    // Run is single-mission in 3a, so history[0] holds the only outcome.
    const lastResult = this.runState.history[this.runState.history.length - 1];
    if (!lastResult) return;
    const resolution: RunResolution = {
      missionId: lastResult.missionId,
      squadIds: this.runState.squad.map((s) => s.id),
      survivorIds: this.runState.survivorIds,
      winner: lastResult.winner,
      unpicked: this.runState.unpickedOutcomes,
    };
    const advanced = advanceCampaignAfterRun(campaign, resolution);
    saveCampaign(advanced);
    this.prevCampaign = campaign;
    this.newCampaign = advanced;
  }

  private makeRoot(): HTMLElement {
    const tpls = listUnitTemplates();
    const tplName = (id: string): string => {
      const entry = this.runState.squad.find((s) => s.id === id);
      const tpl = entry
        ? tpls.find((t) => t.templateId === entry.templateId)
        : null;
      return tpl?.displayName ?? id;
    };

    const success = didRunSucceed(this.runState);
    const totalMissions = this.runState.missionIds.length;
    const completed = this.runState.history.filter(
      (h) => h.winner === 'A',
    ).length;
    const losses = this.runState.squad
      .filter((s) => !this.runState.survivorIds.includes(s.id))
      .map((s) => s.id);
    const survivors = this.runState.survivorIds;

    const headerColor = success ? '#9af09a' : '#ff8a6a';
    const headerLabel = success ? 'RUN 完成' : 'RUN 失敗';

    const lossesHtml = losses.length === 0
      ? '<li style="color:#7a9a7a;font-style:italic;">無人陣亡</li>'
      : losses
          .map(
            (id) => `
        <li style="padding:6px 12px;background:rgba(60,20,20,0.5);border:1px solid #6a3a3a;color:#ff8a8a;display:flex;justify-content:space-between;">
          <span>✗ ${id}</span>
          <span style="color:#a86a6a;">${tplName(id)} — KIA</span>
        </li>
      `,
          )
          .join('');

    const survivorsHtml = survivors
      .map(
        (id) => `
      <li style="padding:6px 12px;background:rgba(20,40,20,0.5);border:1px solid #4a8a5a;color:#9af09a;display:flex;justify-content:space-between;">
        <span>✓ ${id}</span>
        <span style="color:#7aa87a;">${tplName(id)} — 生還</span>
      </li>
    `,
      )
      .join('');

    const boonsHtml = this.runState.pickedBoons
      .map((b) => `<span style="display:inline-block;padding:2px 8px;background:#1a3a2a;border:1px solid #4a8a5a;color:#9af09a;font-size:11px;margin-right:6px;">${b.displayName}</span>`)
      .join('');

    const root = document.createElement('div');
    root.className = 'setup-root';
    root.innerHTML = `
      <h1 style="color:${headerColor};">${headerLabel}</h1>
      <div class="setup-body" style="display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start;">
        <div>
          <h2 style="font-size:14px;color:#9aa89a;margin-bottom:8px;">完成關卡</h2>
          <div style="font-size:32px;color:${headerColor};">${completed}/${totalMissions}</div>
          <div style="margin-top:14px;color:#7a9a7a;font-size:12px;">
            選擇的 boons:
          </div>
          <div style="margin-top:6px;">${boonsHtml || '<span style="color:#7a9a7a;font-style:italic;">無</span>'}</div>
        </div>
        <div>
          <h2 style="font-size:14px;color:#9aa89a;margin-bottom:8px;">隊員命運</h2>
          <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px;">
            ${survivorsHtml}
            ${lossesHtml}
          </ul>
        </div>
      </div>
      <div class="setup-footer" style="justify-content:center;">
        ${
          this.runState.inCampaign
            ? `<button data-action="continue" style="padding:10px 24px;background:#1a3a2a;color:#cfe8cf;border:1px solid #4a8a5a;cursor:pointer;font:inherit;">繼續下一回合 →</button>`
            : `<button data-action="title" style="padding:10px 24px;background:#1a3a2a;color:#cfe8cf;border:1px solid #4a8a5a;cursor:pointer;font:inherit;">回標題</button>`
        }
      </div>
    `;
    document.body.appendChild(root);

    if (this.runState.inCampaign) {
      root.querySelector<HTMLButtonElement>(
        '[data-action="continue"]',
      )!.onclick = () => {
        this.rootEl.remove();
        // RoundResolve needs the campaign snapshots; if applyCampaignOutcome
        // bailed (no save / no history) skip straight to RoundSetup so the
        // player isn't stranded.
        if (this.prevCampaign && this.newCampaign) {
          this.scene.start('RoundResolve', {
            runState: this.runState,
            prevCampaign: this.prevCampaign,
            newCampaign: this.newCampaign,
          });
        } else {
          this.scene.start('RoundSetup');
        }
      };
    } else {
      root.querySelector<HTMLButtonElement>('[data-action="title"]')!.onclick =
        () => {
          this.rootEl.remove();
          this.scene.start('Title');
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
