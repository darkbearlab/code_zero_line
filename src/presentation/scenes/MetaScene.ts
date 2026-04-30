/**
 * MetaScene — 指揮部 hub view. Phase 3c entry: currency panel + pool
 * browser. Veterans (sorties ≥ 1) get highlighted so the player can see
 * which roster members have actual run history. Region map + score table
 * land in later phases.
 *
 * Reached from RoundSetupScene via the 「指揮部」button. From here the
 * player can drill into the upgrade tree or back to the round picker.
 */
import Phaser from 'phaser';
import {
  listUnitTemplates,
  type RecruitRole,
  type UnitTemplate,
} from '../../config/loader';
import { type CampaignState } from '../../campaign/state';
import { POOL_TARGET, ROLE_TARGETS } from '../../campaign/recruit';
import { loadCampaign } from '../../campaign/persist';
import { veteranAdjustedQuality } from '../../campaign/veteran';

const ROLE_BADGE: Readonly<Record<RecruitRole, string>> = {
  officer: 'O',
  specialist: 'S',
  regular: 'R',
};

const ROLE_LABEL: Readonly<Record<RecruitRole, string>> = {
  officer: '士官',
  specialist: '專家',
  regular: '一般',
};

const ROLE_COLOR: Readonly<Record<RecruitRole, string>> = {
  officer: '#cfa1c1',
  specialist: '#a1c1cf',
  regular: '#9aa89a',
};

export class MetaScene extends Phaser.Scene {
  private rootEl!: HTMLElement;
  private campaign!: CampaignState;

  constructor() {
    super({ key: 'Meta' });
  }

  create(): void {
    hideBattleHud();
    const loaded = loadCampaign();
    if (!loaded) {
      this.scene.start('Title');
      return;
    }
    this.campaign = loaded;
    this.rootEl = this.makeRoot();
    this.events.once('shutdown', () => this.rootEl?.remove());
  }

  private makeRoot(): HTMLElement {
    const tpls = listUnitTemplates();
    const tplById = new Map<string, UnitTemplate>(
      tpls.map((t) => [t.templateId, t] as const),
    );
    const cur = this.campaign.currencies;

    const roleCounts: Record<RecruitRole, number> = {
      officer: 0,
      specialist: 0,
      regular: 0,
    };
    for (const e of this.campaign.pool) {
      const tpl = tplById.get(e.templateId);
      const role = tpl?.recruitRole ?? 'regular';
      roleCounts[role] += 1;
    }

    // Sort: veterans (sorties high) first within role, role-priority O/S/R.
    const ROLE_ORDER: Record<RecruitRole, number> = {
      officer: 0,
      specialist: 1,
      regular: 2,
    };
    const sorted = [...this.campaign.pool].sort((a, b) => {
      const ra = tplById.get(a.templateId)?.recruitRole ?? 'regular';
      const rb = tplById.get(b.templateId)?.recruitRole ?? 'regular';
      if (ROLE_ORDER[ra] !== ROLE_ORDER[rb]) {
        return ROLE_ORDER[ra] - ROLE_ORDER[rb];
      }
      const sa = a.sorties ?? 0;
      const sb = b.sorties ?? 0;
      if (sa !== sb) return sb - sa; // higher sorties first
      return a.id.localeCompare(b.id);
    });

    const rowsHtml = sorted
      .map((e) => {
        const tpl = tplById.get(e.templateId);
        const role: RecruitRole = tpl?.recruitRole ?? 'regular';
        const sorties = e.sorties ?? 0;
        const veteran = sorties >= 1;
        const star = veteran ? '★' : '·';
        const starColor = veteran ? '#f0d090' : '#5a6a5a';
        const rowBg = veteran ? 'rgba(40,32,18,0.55)' : 'rgba(20,30,20,0.55)';
        const rowBorder = veteran ? '#7a6a3a' : '#2a3a2a';
        const tplName = tpl?.displayName ?? e.templateId;
        const quality = tpl?.quality ?? 4;
        // 老兵自動成長：sortie 3 次 → 素質 -1，最多到 q3+（design §6.3）。
        const effectiveQ = veteranAdjustedQuality(quality, sorties);
        const qualityHtml = effectiveQ === quality
          ? `<span style="color:#7a8a7a;margin-left:6px;font-size:10px;">q${quality}+</span>`
          : `<span style="color:#7a8a7a;margin-left:6px;font-size:10px;text-decoration:line-through;">q${quality}+</span>
             <span style="color:#f0d090;margin-left:4px;font-size:10px;font-weight:bold;">q${effectiveQ}+</span>`;
        return `
          <li style="padding:7px 12px;background:${rowBg};border:1px solid ${rowBorder};display:grid;grid-template-columns:auto 1fr auto auto;gap:12px;align-items:center;font-size:12px;">
            <span style="color:${starColor};width:16px;text-align:center;">${star}</span>
            <span>
              <span style="color:#cfe8cf;">${e.id}</span>
              <span style="color:#7a9a7a;margin-left:8px;">${tplName}</span>
              ${qualityHtml}
            </span>
            <span title="${ROLE_LABEL[role]}" style="font-weight:bold;color:${ROLE_COLOR[role]};font-size:11px;">[${ROLE_BADGE[role]}]</span>
            <span style="color:${veteran ? '#f0d090' : '#7a9a7a'};font-size:11px;min-width:62px;text-align:right;">出擊 ${sorties}</span>
          </li>
        `;
      })
      .join('');

    const root = document.createElement('div');
    root.className = 'setup-root';
    root.innerHTML = `
      <h1>指揮部</h1>
      <div class="setup-body" style="max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(20,30,20,0.6);border:1px solid #3a5a3a;font-size:13px;">
          <div style="display:flex;gap:18px;">
            <span style="color:#cfd1a1;">作戰情報 ${cur.tactical}</span>
            <span style="color:#a1c1cf;">區域情報 ${cur.regional}</span>
            <span style="color:#cfa1c1;">榮譽 ${cur.honor}</span>
          </div>
          <div style="color:#7a9a7a;font-size:11px;">
            戰役回合 ${this.campaign.roundIndex} · 已完成 run ${this.campaign.runsCompleted}
          </div>
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;">
            <h2 style="font-size:14px;color:#cfe8cf;margin:0;">兵力池</h2>
            <span style="color:#7a9a7a;font-size:11px;">
              ${this.campaign.pool.length}/${POOL_TARGET}
              <span style="margin-left:10px;color:${ROLE_COLOR.officer};">士 ${roleCounts.officer}/${ROLE_TARGETS.officer}</span>
              <span style="margin-left:6px;color:${ROLE_COLOR.specialist};">專 ${roleCounts.specialist}/${ROLE_TARGETS.specialist}</span>
              <span style="margin-left:6px;color:${ROLE_COLOR.regular};">一般 ${roleCounts.regular}/${ROLE_TARGETS.regular}</span>
            </span>
          </div>
          <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px;max-height:54vh;overflow-y:auto;">
            ${rowsHtml}
          </ul>
          <div style="margin-top:8px;color:#7a9a7a;font-size:10px;">
            ★ = 老兵(出擊 ≥ 1)。每 3 次出擊自動素質 +1 (design §6.3),封頂 q3+。
          </div>
        </div>
      </div>
      <div class="setup-footer">
        <button data-action="back" style="padding:8px 18px;background:#1a2a1a;color:#cfe8cf;border:1px solid #3a5a3a;cursor:pointer;font:inherit;">← 回戰役回合</button>
        <button data-action="upgrade" style="margin-left:auto;padding:8px 18px;background:#1a3a3a;color:#a1cfd1;border:1px solid #4a8a8a;cursor:pointer;font:inherit;">升級樹 →</button>
      </div>
    `;
    document.body.appendChild(root);

    root.querySelector<HTMLButtonElement>('[data-action="back"]')!.onclick =
      () => {
        this.rootEl.remove();
        this.scene.start('RoundSetup');
      };
    root.querySelector<HTMLButtonElement>('[data-action="upgrade"]')!.onclick =
      () => {
        this.rootEl.remove();
        this.scene.start('Upgrade');
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
