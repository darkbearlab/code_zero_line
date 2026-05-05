/**
 * RunSetupScene — pre-run preview. Phase 1 hard-codes a 4-unit squad
 * (squad_lead + elite + 2 troopers) and shows the upcoming missions.
 * Phase 3 replaces this with a slot-based draft from the persistent pool.
 */
import Phaser from 'phaser';
import { listUnitTemplates } from '../../config/loader';
import { getMissionById } from '../../missions/library';
import { pickMissions } from '../../missions/pick';
import { newRunState } from '../../runs/state';
import { nextMissionNeedsDeployScene } from '../../runs/launchMission';
import type { RosterEntry } from '../../core/setup/types';

const PHASE1_SQUAD: ReadonlyArray<RosterEntry> = [
  { id: 'sq-1', templateId: 'squad_lead' },
  { id: 'sq-2', templateId: 'elite' },
  { id: 'sq-3', templateId: 'trooper' },
  { id: 'sq-4', templateId: 'trooper' },
];

export class RunSetupScene extends Phaser.Scene {
  private rootEl!: HTMLElement;
  /**
   * Per-instance run draft. The seed is fixed when the scene mounts so the
   * mission preview matches what the player will actually fight if they
   * click "出擊"; rerolling = reload the scene.
   */
  private runSeed!: string;
  private missionIds!: ReadonlyArray<string>;

  constructor() {
    super({ key: 'RunSetup' });
  }

  create(): void {
    hideBattleHud();
    this.runSeed = `run-${Date.now()}`;
    this.missionIds = pickMissions(this.runSeed, 3);
    this.rootEl = this.makeRoot();
    this.events.once('shutdown', () => this.rootEl?.remove());
  }

  private makeRoot(): HTMLElement {
    const tpls = listUnitTemplates();
    const tplName = (id: string): string =>
      tpls.find((t) => t.templateId === id)?.displayName ?? id;
    const tplQuality = (id: string): number =>
      tpls.find((t) => t.templateId === id)?.quality ?? 4;

    const squadHtml = PHASE1_SQUAD.map(
      (s) => `
      <li style="padding:6px 12px;background:rgba(20,30,20,0.5);border:1px solid #2a3a2a;display:flex;justify-content:space-between;">
        <span><strong>${s.id}</strong> — ${tplName(s.templateId)}</span>
        <span style="color:#9aa89a;">q${tplQuality(s.templateId)}+</span>
      </li>
    `,
    ).join('');

    const drafted = this.missionIds.map((id) => getMissionById(id));
    const missionsHtml = drafted.map(
      (m, i) => `
      <li style="padding:8px 12px;background:rgba(20,30,20,0.4);border:1px solid #2a3a2a;display:flex;justify-content:space-between;align-items:center;">
        <span><strong>關 ${i + 1}</strong> — ${m.displayName}</span>
        <span style="color:#7a9a7a;font-size:12px;">${m.description}</span>
      </li>
    `,
    ).join('');

    const root = document.createElement('div');
    root.className = 'setup-root';
    root.innerHTML = `
      <h1>Run Briefing</h1>
      <div class="setup-body" style="display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start;">
        <div>
          <h2 style="font-size:14px;color:#9aa89a;margin-bottom:8px;">你接手的小隊 (4 人)</h2>
          <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px;">
            ${squadHtml}
          </ul>
          <div style="margin-top:14px;color:#7a9a7a;font-size:12px;line-height:1.6;">
            這支小隊已經在前線就位。你接手指揮 3 場行動。<br/>
            每場間有一個 Hub,前線會回報三個選項給你。
          </div>
        </div>
        <div>
          <h2 style="font-size:14px;color:#9aa89a;margin-bottom:8px;">行動順序</h2>
          <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px;">
            ${missionsHtml}
          </ul>
        </div>
      </div>
      <div class="setup-footer">
        <button data-action="cancel" style="padding:6px 14px;background:#1a2a1a;color:#cfe8cf;border:1px solid #3a5a3a;cursor:pointer;font:inherit;">← 回標題</button>
        <button data-action="begin" style="margin-left:auto;padding:8px 18px;background:#1a3a2a;color:#cfe8cf;border:1px solid #4a8a5a;cursor:pointer;font:inherit;">出擊 →</button>
      </div>
    `;
    document.body.appendChild(root);

    root.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.onclick =
      () => {
        this.rootEl.remove();
        this.scene.start('Title');
      };
    root.querySelector<HTMLButtonElement>('[data-action="begin"]')!.onclick =
      () => {
        const run = newRunState(this.runSeed, PHASE1_SQUAD, this.missionIds);
        this.rootEl.remove();
        if (nextMissionNeedsDeployScene(run)) {
          this.scene.start('Deploy', { runState: run });
        } else {
          this.scene.start('Battle', { runState: run });
        }
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
