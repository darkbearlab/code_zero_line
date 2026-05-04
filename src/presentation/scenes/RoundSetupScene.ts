/**
 * RoundSetupScene — Phase 3a campaign loop entry. The player sees N
 * mission cards (currently 3), each pre-allocated a 4-unit squad drafted
 * from the campaign pool. Picking a card commits that mission's squad
 * to a single-mission RunState and starts the battle. Unpicked options
 * vanish in 3a — fuzzy-roll resolution lands in 3b.
 *
 * Campaign state is loaded from localStorage on entry. If no save
 * exists, the scene self-bootstraps a new campaign so a hard refresh
 * doesn't leave the player stranded.
 */
import Phaser from 'phaser';
import { listUnitTemplates } from '../../config/loader';
import { getMissionById } from '../../missions/library';
import { newRunState, type RunOperationContext } from '../../runs/state';
import { saveRun, clearRun } from '../../runs/persist';
import {
  isCampaignOver,
  newCampaignState,
  type CampaignState,
} from '../../campaign/state';
import { loadCampaign, saveCampaign } from '../../campaign/persist';
import { newRoundState, type RoundState } from '../../rounds/state';
import { resolveUnpickedOptions } from '../../rounds/autoResolve';
import { veteranAdjustedQuality } from '../../campaign/veteran';
import { getOperationDef } from '../../config/loader';

const SCENARIO_LABEL: Readonly<Record<string, string>> = {
  'engage-reach': '攻佔目標',
  defend: '陣地堅守',
  extract: '緊急撤離',
  assassinate: '斬首行動',
  elimination: '殲滅',
};

const SCENARIO_ICON: Readonly<Record<string, string>> = {
  'engage-reach': '⛳',
  defend: '🛡',
  extract: '🚁',
  assassinate: '🎯',
  elimination: '⚔',
};

const STAGE_LABEL: Readonly<Record<string, string>> = {
  ELIM: '殲滅',
  MAIN: '主任務',
};

// Internal 1-5 difficulty rolled up into 3 visible tiers (低/中/高).
const difficultyBand = (d: number): { label: string; color: string } => {
  if (d <= 2) return { label: '低', color: '#9af09a' };
  if (d === 3) return { label: '中', color: '#f0d090' };
  return { label: '高', color: '#ff8a6a' };
};

export class RoundSetupScene extends Phaser.Scene {
  private rootEl!: HTMLElement;
  private campaign!: CampaignState;
  private round!: RoundState;

  constructor() {
    super({ key: 'RoundSetup' });
  }

  create(): void {
    hideBattleHud();
    // Load existing campaign or self-bootstrap a fresh one. TitleScene
    // is the canonical entry point but a refresh mid-campaign should
    // also Just Work.
    const loaded = loadCampaign();
    this.campaign = loaded ?? newCampaignState(`camp-${Date.now()}`);
    if (!loaded) saveCampaign(this.campaign);
    this.round = newRoundState(this.campaign);
    this.rootEl = this.makeRoot();
    this.events.once('shutdown', () => this.rootEl?.remove());
  }

  private makeRoot(): HTMLElement {
    const tpls = listUnitTemplates();
    const tplName = (templateId: string): string =>
      tpls.find((t) => t.templateId === templateId)?.displayName ?? templateId;
    const tplQuality = (templateId: string): number =>
      tpls.find((t) => t.templateId === templateId)?.quality ?? 4;

    const root = document.createElement('div');
    root.className = 'setup-root';

    if (isCampaignOver(this.campaign)) {
      root.innerHTML = this.renderCampaignOver();
      document.body.appendChild(root);
      this.wireCampaignOver(root);
      return root;
    }

    const cardsHtml = this.round.options
      .map((opt, i) => {
        const opDef = getOperationDef(opt.operation.operationId);
        const mainMissionId =
          opt.operation.missionIds[opt.operation.missionIds.length - 1]!;
        const mainMission = getMissionById(mainMissionId);
        const opBand = difficultyBand(opDef.difficulty);

        // Per-stage chip preview: scenario icon + per-mission band.
        const chainHtml = opt.operation.missionIds
          .map((mid, stageIdx) => {
            const m = getMissionById(mid);
            const label = opt.operation.stageLabels[stageIdx] ?? 'ELIM';
            const band = difficultyBand(m.difficulty);
            const icon = SCENARIO_ICON[m.scenario] ?? '·';
            return `
              <div style="display:flex;align-items:center;gap:6px;padding:4px 8px;background:rgba(10,20,10,0.5);border:1px solid #2a4a2a;font-size:11px;">
                <span style="color:#7a9a7a;">${stageIdx + 1}.</span>
                <span title="${SCENARIO_LABEL[m.scenario] ?? m.scenario}">${icon}</span>
                <span style="color:#cfe8cf;">${STAGE_LABEL[label] ?? label}</span>
                <span style="color:${band.color};margin-left:auto;">${band.label}</span>
              </div>
            `;
          })
          .join('');

        // Total expected currencies = perStage × N + onComplete (if all stages clear).
        const stages = opt.operation.stageLabels.length;
        const r = opDef.rewards;
        const total = {
          tactical: r.perStage.tactical * stages + r.onComplete.tactical,
          regional: r.perStage.regional * stages + r.onComplete.regional,
          honor: r.perStage.honor * stages + r.onComplete.honor,
        };

        const squadHtml = opt.squadIds
          .map((id) => {
            const member = this.campaign.pool.find((u) => u.id === id);
            const tpl = member ? member.templateId : id;
            const baseQ = tplQuality(tpl);
            const sorties = member?.sorties ?? 0;
            const effQ = veteranAdjustedQuality(baseQ, sorties);
            const veteranBadge = sorties >= 1
              ? `<span style="color:#f0d090;margin-left:4px;" title="出擊 ${sorties} 次">★</span>`
              : '';
            const qHtml = effQ === baseQ
              ? `<span style="color:#9aa89a;">q${baseQ}+</span>`
              : `<span style="color:#7a8a7a;text-decoration:line-through;">q${baseQ}+</span>
                 <span style="color:#f0d090;font-weight:bold;margin-left:2px;">q${effQ}+</span>`;
            return `<li style="padding:3px 0;font-size:11px;color:#cfe8cf;">
              <span style="color:#7aa87a;">${id}</span> — ${tplName(tpl)}
              ${qHtml}${veteranBadge}
            </li>`;
          })
          .join('');

        return `
          <div data-card="${i}" style="padding:14px 16px;background:rgba(20,30,20,0.6);border:1px solid #3a5a3a;cursor:pointer;display:flex;flex-direction:column;gap:10px;transition:background 0.15s,border-color 0.15s;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">
              <strong style="color:#cfe8cf;font-size:15px;">${opDef.displayName}</strong>
              <span style="color:${opBand.color};font-size:11px;font-weight:bold;">難度:${opBand.label}</span>
            </div>
            <div style="color:#7aa87a;font-size:11px;">
              ${SCENARIO_ICON[mainMission.scenario] ?? ''} 主任務:${mainMission.displayName}
              <span style="color:#7a9a7a;">(${SCENARIO_LABEL[mainMission.scenario] ?? mainMission.scenario})</span>
            </div>
            <div style="color:#9aa89a;font-size:11px;line-height:1.5;">${opDef.description}</div>
            <div style="display:flex;flex-direction:column;gap:3px;border-top:1px solid #2a3a2a;padding-top:8px;">
              ${chainHtml}
            </div>
            <div style="font-size:11px;color:#cfd1a1;border-top:1px solid #2a3a2a;padding-top:8px;">
              預期總獎:作戰 ${total.tactical} · 區域 ${total.regional} · 榮譽 ${total.honor}
            </div>
            <ul style="list-style:none;padding:0;margin:0;border-top:1px solid #2a3a2a;padding-top:8px;">
              ${squadHtml}
            </ul>
            <div style="display:flex;justify-content:flex-end;align-items:center;color:#cfe8cf;font-size:11px;">
              <span>點擊出擊 →</span>
            </div>
          </div>
        `;
      })
      .join('');

    const cur = this.campaign.currencies;

    root.innerHTML = `
      <h1>戰役回合 ${this.campaign.roundIndex}</h1>
      <div class="setup-body">
        <div style="display:flex;justify-content:space-between;color:#7a9a7a;font-size:12px;margin-bottom:14px;">
          <span>池子:${this.campaign.pool.length} 人</span>
          <span>已完成 run:${this.campaign.runsCompleted}</span>
          <span style="color:#cfd1a1;">作戰 ${cur.tactical} · 區域 ${cur.regional} · 榮譽 ${cur.honor}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(${this.round.options.length},1fr);gap:14px;">
          ${cardsHtml}
        </div>
      </div>
      <div class="setup-footer">
        <button data-action="title" style="padding:6px 14px;background:#1a2a1a;color:#cfe8cf;border:1px solid #3a5a3a;cursor:pointer;font:inherit;">← 回標題</button>
        <button data-action="meta" style="margin-left:12px;padding:6px 14px;background:#2a2a3a;color:#a1a1cf;border:1px solid #5a5a8a;cursor:pointer;font:inherit;">指揮部</button>
        <button data-action="upgrade" style="margin-left:12px;padding:6px 14px;background:#1a3a3a;color:#a1cfd1;border:1px solid #4a8a8a;cursor:pointer;font:inherit;">升級樹</button>
        <button data-action="abandon" style="margin-left:auto;padding:6px 14px;background:#3a1a1a;color:#cfa8a8;border:1px solid #6a3a3a;cursor:pointer;font:inherit;">放棄戰役</button>
      </div>
    `;
    document.body.appendChild(root);

    // Card hover + click wiring
    root.querySelectorAll<HTMLElement>('[data-card]').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        el.style.background = 'rgba(30,50,30,0.7)';
        el.style.borderColor = '#5a8a5a';
      });
      el.addEventListener('mouseleave', () => {
        el.style.background = 'rgba(20,30,20,0.6)';
        el.style.borderColor = '#3a5a3a';
      });
      el.addEventListener('click', () => {
        const idx = Number(el.dataset.card);
        if (Number.isNaN(idx)) return;
        this.commitOption(idx);
      });
    });

    root.querySelector<HTMLButtonElement>('[data-action="title"]')!.onclick =
      () => {
        this.rootEl.remove();
        this.scene.start('Title');
      };
    root.querySelector<HTMLButtonElement>('[data-action="meta"]')!.onclick =
      () => {
        this.rootEl.remove();
        this.scene.start('Meta');
      };
    root.querySelector<HTMLButtonElement>('[data-action="upgrade"]')!.onclick =
      () => {
        this.rootEl.remove();
        this.scene.start('Upgrade');
      };
    root.querySelector<HTMLButtonElement>('[data-action="abandon"]')!.onclick =
      () => {
        if (!confirm('放棄戰役會清除目前進度,確定?')) return;
        // Lazy import to avoid circular load in test envs.
        import('../../campaign/persist').then((m) => {
          m.clearCampaign();
          clearRun();
          this.rootEl.remove();
          this.scene.start('Title');
        });
      };

    return root;
  }

  private commitOption(idx: number): void {
    const option = this.round.options[idx];
    if (!option) return;
    // Build the mission-side squad from the drafted pool members.
    const draftedSquad = option.squadIds
      .map((id) => this.campaign.pool.find((u) => u.id === id))
      .filter((u): u is NonNullable<typeof u> => !!u);
    if (draftedSquad.length === 0) return;
    const runSeed = `${this.round.seed}-pick-${idx}`;
    // Snapshot the operation's reward template into the run so banking
    // is deterministic across editor edits mid-run.
    const opDef = getOperationDef(option.operation.operationId);
    const operationCtx: RunOperationContext = {
      operationId: option.operation.operationId,
      stageLabels: option.operation.stageLabels,
      perStageReward: opDef.rewards.perStage,
      onCompleteReward: opDef.rewards.onComplete,
      ...(opDef.stealthEntry === true ? { stealthEntry: true } : {}),
    };
    const run = newRunState(
      runSeed,
      draftedSquad,
      option.operation.missionIds,
      operationCtx,
    );
    // Pre-roll the auto-resolved fates of every unpicked option (§4.1).
    // Done here so the fates are deterministic and survive a reload —
    // RunResultScene will pass them through to advanceCampaignAfterRun.
    const unpickedOutcomes = resolveUnpickedOptions(
      this.round.options,
      idx,
      runSeed,
    );
    // Snapshot campaign upgrades into the run so a mid-battle purchase
    // (impossible right now, but cheap insurance) can't retro-buff the
    // active mission.
    const campaignRun = {
      ...run,
      inCampaign: true as const,
      upgradeLevels: { ...this.campaign.upgradeLevels },
      unpickedOutcomes,
    };
    // Snapshot the fresh run so a tab-close mid-operation can resume.
    saveRun(campaignRun);
    this.rootEl.remove();
    this.scene.start('Battle', { runState: campaignRun });
  }

  private renderCampaignOver(): string {
    const cur = this.campaign.currencies;
    return `
      <h1 style="color:#ff8a6a;">戰役結束</h1>
      <div class="setup-body">
        <div style="text-align:center;color:#9aa89a;line-height:1.7;max-width:480px;margin:0 auto;">
          可用兵力剩 ${this.campaign.pool.length} 人,不足以編組下一場任務。<br/>
          完成 run:${this.campaign.runsCompleted}<br/>
          作戰 ${cur.tactical} · 區域 ${cur.regional} · 榮譽 ${cur.honor}
        </div>
      </div>
      <div class="setup-footer" style="justify-content:center;">
        <button data-action="reset" style="padding:10px 24px;background:#1a3a2a;color:#cfe8cf;border:1px solid #4a8a5a;cursor:pointer;font:inherit;">開始新戰役</button>
        <button data-action="title" style="padding:10px 24px;background:#1a2a1a;color:#cfe8cf;border:1px solid #3a5a3a;cursor:pointer;font:inherit;margin-left:12px;">回標題</button>
      </div>
    `;
  }

  private wireCampaignOver(root: HTMLElement): void {
    root.querySelector<HTMLButtonElement>('[data-action="reset"]')!.onclick =
      () => {
        import('../../campaign/persist').then((m) => {
          m.clearCampaign();
          clearRun();
          this.rootEl.remove();
          this.scene.start('RoundSetup');
        });
      };
    root.querySelector<HTMLButtonElement>('[data-action="title"]')!.onclick =
      () => {
        this.rootEl.remove();
        this.scene.start('Title');
      };
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
