/**
 * TitleScene — Phase 1 vertical-slice landing page. Currently exposes
 * "New Run" + a "Battle Sandbox (legacy)" link to the original 1v1
 * RosterScene flow so we can still test rules edge cases. Multiplayer /
 * MetaScene placeholders are stubs for later phases.
 */
import Phaser from 'phaser';

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
    const root = document.createElement('div');
    root.className = 'setup-root';
    root.innerHTML = `
      <h1>Code: Zero Line</h1>
      <div class="setup-body" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;">
        <div style="text-align:center;color:#7a9a7a;font-size:14px;line-height:1.6;max-width:480px;">
          多支小隊同時進攻一個堅固目標。<br/>
          你接手其中一支,完成 3 場任務算 run 過關。<br/>
          <span style="color:#9a9a9a;font-style:italic;">(Phase 1 vertical slice — 多場戰鬥 + Hub + 結算 loop)</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;width:280px;">
          <button data-action="new-run" style="padding:12px;font:inherit;font-size:16px;background:#1a3a2a;color:#cfe8cf;border:1px solid #4a8a5a;cursor:pointer;">▶ New Run</button>
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
