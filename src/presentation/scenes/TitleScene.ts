/**
 * TitleScene — landing page. Phase 3a adds Campaign entry alongside the
 * vertical-slice "New Run" (3-mission unmoored run) and the legacy 1v1
 * sandbox. Continue Campaign appears only when a save exists.
 * Multiplayer / MetaScene placeholders are stubs for later phases.
 */
import Phaser from 'phaser';
import {
  hasSavedCampaign,
  clearCampaign,
} from '../../campaign/persist';

export class TitleScene extends Phaser.Scene {
  private rootEl!: HTMLElement;

  constructor() {
    super({ key: 'Title' });
  }

  create(): void {
    hideBattleHud();
    this.rootEl = this.makeRoot();
    this.events.once('shutdown', () => this.rootEl?.remove());
  }

  private makeRoot(): HTMLElement {
    const hasSave = hasSavedCampaign();
    const root = document.createElement('div');
    root.className = 'setup-root';
    root.innerHTML = `
      <h1>Code: Zero Line</h1>
      <div class="setup-body" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;">
        <div style="text-align:center;color:#7a9a7a;font-size:14px;line-height:1.6;max-width:480px;">
          多支小隊同時進攻一個堅固目標。<br/>
          你接手其中一支,參與多階段侵攻。<br/>
          <span style="color:#9a9a9a;font-style:italic;">(Phase 3a — Campaign + Round 骨架)</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;width:280px;">
          ${
            hasSave
              ? `<button data-action="continue" style="padding:12px;font:inherit;font-size:16px;background:#1a3a2a;color:#cfe8cf;border:1px solid #4a8a5a;cursor:pointer;">▶ Continue Campaign</button>
                 <button data-action="new-campaign" style="padding:8px;font:inherit;font-size:13px;background:#3a1a1a;color:#cfa8a8;border:1px solid #6a3a3a;cursor:pointer;">New Campaign (清除存檔)</button>`
              : `<button data-action="new-campaign" style="padding:12px;font:inherit;font-size:16px;background:#1a3a2a;color:#cfe8cf;border:1px solid #4a8a5a;cursor:pointer;">▶ New Campaign</button>`
          }
          <button data-action="new-run" style="padding:8px;font:inherit;font-size:13px;background:#1a2a1a;color:#9aa89a;border:1px solid #3a5a3a;cursor:pointer;">3-Mission Run (legacy)</button>
          <button data-action="sandbox" style="padding:8px;font:inherit;font-size:13px;background:#1a2a1a;color:#9aa89a;border:1px solid #3a5a3a;cursor:pointer;">Battle Sandbox (1v1)</button>
          <button disabled style="padding:8px;font:inherit;font-size:13px;background:#0a1a0a;color:#5a6a5a;border:1px solid #2a3a2a;cursor:not-allowed;">Multiplayer (locked)</button>
          <a data-action="editor" href="./editor.html" target="_blank" rel="noopener" style="padding:8px;font:inherit;font-size:13px;background:#1a2a1a;color:#9aa89a;border:1px solid #3a5a3a;cursor:pointer;text-align:center;text-decoration:none;">Open Editor ↗</a>
        </div>
      </div>
      <div class="setup-footer" style="justify-content:center;color:#7a9a7a;font-size:11px;">
        v0.1 vertical slice
      </div>
    `;
    document.body.appendChild(root);

    const continueBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="continue"]',
    );
    if (continueBtn) {
      continueBtn.onclick = () => {
        this.rootEl.remove();
        this.scene.start('RoundSetup');
      };
    }
    const newCampaignBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="new-campaign"]',
    );
    if (newCampaignBtn) {
      newCampaignBtn.onclick = () => {
        if (hasSavedCampaign()) {
          if (!confirm('開新戰役會清除目前存檔,確定?')) return;
          clearCampaign();
        }
        this.rootEl.remove();
        this.scene.start('RoundSetup');
      };
    }
    root.querySelector<HTMLButtonElement>('[data-action="new-run"]')!.onclick =
      () => {
        this.rootEl.remove();
        this.scene.start('RunSetup');
      };
    root.querySelector<HTMLButtonElement>('[data-action="sandbox"]')!.onclick =
      () => {
        this.rootEl.remove();
        this.scene.start('Roster');
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
