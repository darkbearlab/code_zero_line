import Phaser from 'phaser';
import { applyCommand } from '../../core/commands/reducer';
import type { GameEvent } from '../../core/commands/types';
import { CommandError } from '../../core/commands/types';
import type { Vec2 } from '../../core/geometry/types';
import { UNIT_DISTANCE_PIXELS } from '../../core/rules/constants';
import type { GameState, Unit } from '../../core/state/GameState';
import { isUnitAlive } from '../../core/state/GameState';
import { drawTerrain } from '../rendering/terrain';
import { paintBoardFloorPhaser } from '../rendering/boardFloor';
import type { ReplayLog } from '../../core/replay/log';
import { loadLatestReplay } from '../../core/replay/storage';
import { BATTLEFIELD_SIZE_PIXELS } from '../state/setupBattleState';

const FACTION_COLOR: Readonly<Record<'A' | 'B', number>> = {
  A: 0x4a8acf,
  B: 0xcf5a4a,
};


const STEP_INTERVAL_MS = 800;

export class ReplayScene extends Phaser.Scene {
  private log: ReplayLog | null = null;
  private gameState!: GameState;
  private commandIndex = 0;
  private terrainGfx!: Phaser.GameObjects.Graphics;
  private boardEdgeGfx!: Phaser.GameObjects.Graphics;
  private unitLayer!: Phaser.GameObjects.Container;
  private unitContainers = new Map<string, Phaser.GameObjects.Container>();
  private overlayEl!: HTMLElement;
  private logLines: string[] = [];
  private playing = false;
  private pendingTween = 0;
  private stepEvent: Phaser.Time.TimerEvent | null = null;

  constructor() {
    super({ key: 'Replay' });
  }

  create(): void {
    // Reset per scene entry (Phaser reuses scene instances).
    this.commandIndex = 0;
    this.unitContainers = new Map();
    this.logLines = [];
    this.playing = false;
    this.pendingTween = 0;
    this.stepEvent = null;
    this.log = loadLatestReplay();
    this.cameras.main.setBackgroundColor('#0a0c0a');
    this.boardEdgeGfx = this.add.graphics();
    this.terrainGfx = this.add.graphics();
    this.unitLayer = this.add.container();

    this.fitCamera();
    const resizeHandler = () => this.fitCamera();
    this.scale.on('resize', resizeHandler);
    this.events.once('shutdown', () => this.scale.off('resize', resizeHandler));

    this.overlayEl = this.makeOverlay();
    this.events.once('shutdown', () => {
      this.overlayEl?.remove();
      document.getElementById('replay-log')?.remove();
    });

    if (!this.log) {
      this.appendLog('No replay available — go back to battle and save one first.');
      this.renderEmpty();
      return;
    }
    this.gameState = clone(this.log.initialState);
    this.commandIndex = 0;
    this.renderTerrain();
    this.renderUnits();
    this.appendLog(
      `Loaded replay (${this.log.commands.length} commands, recorded ${this.log.recordedAt}).`,
    );
    this.input.keyboard?.on('keydown-SPACE', () => this.togglePlay());
    this.input.keyboard?.on('keydown-ESC', () => this.exitToBattle());
    this.startPlayback();
  }

  shutdown(): void {
    if (this.stepEvent) {
      this.stepEvent.remove();
      this.stepEvent = null;
    }
    this.overlayEl.remove();
  }

  private fitCamera(): void {
    const cam = this.cameras.main;
    const margin = 0.92;
    const zoom =
      Math.min(
        cam.width / BATTLEFIELD_SIZE_PIXELS,
        cam.height / BATTLEFIELD_SIZE_PIXELS,
      ) * margin;
    cam.setZoom(zoom);
    cam.centerOn(BATTLEFIELD_SIZE_PIXELS / 2, BATTLEFIELD_SIZE_PIXELS / 2);
    this.boardEdgeGfx.clear();
    paintBoardFloorPhaser(this.boardEdgeGfx, BATTLEFIELD_SIZE_PIXELS);
    this.boardEdgeGfx.lineStyle(2, 0x2a3a2a);
    this.boardEdgeGfx.strokeRect(
      0,
      0,
      BATTLEFIELD_SIZE_PIXELS,
      BATTLEFIELD_SIZE_PIXELS,
    );
  }

  private renderEmpty(): void {
    const t = this.add.text(
      BATTLEFIELD_SIZE_PIXELS / 2,
      BATTLEFIELD_SIZE_PIXELS / 2,
      'No replay saved.\nPress ESC to return.',
      {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '20px',
        color: '#cfe8cf',
        align: 'center',
      },
    );
    t.setOrigin(0.5);
    this.input.keyboard?.on('keydown-ESC', () => this.exitToBattle());
  }

  private renderTerrain(): void {
    this.terrainGfx.clear();
    for (const t of this.gameState.terrain) drawTerrain(this.terrainGfx, t);
  }

  private renderUnits(): void {
    const aliveIds = new Set<string>();
    for (const u of this.gameState.units) {
      if (isUnitAlive(u)) aliveIds.add(u.id);
    }
    for (const [id, container] of [...this.unitContainers]) {
      if (!aliveIds.has(id)) {
        container.destroy();
        this.unitContainers.delete(id);
      }
    }
    for (const u of this.gameState.units) {
      if (!isUnitAlive(u)) continue;
      let container = this.unitContainers.get(u.id);
      if (!container) {
        container = this.createUnitContainer(u);
        this.unitContainers.set(u.id, container);
        this.unitLayer.add(container);
      }
      this.updateUnitVisuals(container, u);
    }
  }

  private createUnitContainer(u: Unit): Phaser.GameObjects.Container {
    const container = this.add.container(u.position.x, u.position.y);
    const arc = this.add.circle(0, 0, u.radius, FACTION_COLOR[u.faction]);
    arc.setName('arc');
    arc.setStrokeStyle(1.5, 0xffffff);
    container.add(arc);
    const label = this.add.text(0, -u.radius - 14, `${u.id}\n${u.quality}+`, {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '10px',
      color: '#cfe8cf',
      align: 'center',
    });
    label.setName('label');
    label.setOrigin(0.5);
    container.add(label);
    return container;
  }

  private updateUnitVisuals(
    container: Phaser.GameObjects.Container,
    u: Unit,
  ): void {
    const arc = container.getByName('arc') as Phaser.GameObjects.Arc | null;
    if (!arc) return;
    const isActive =
      this.gameState.initiative.activeActivation?.unitId === u.id;
    arc.setStrokeStyle(isActive ? 2.5 : 1.5, isActive ? 0x9af09a : 0xffffff);
    let tag = container.getByName('damage-tag') as
      | Phaser.GameObjects.Text
      | null;
    if (u.damage === 'NONE') {
      if (tag) tag.destroy();
    } else {
      if (!tag) {
        tag = this.add.text(0, u.radius + 4, u.damage, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '9px',
          color: '#ffaa55',
        });
        tag.setName('damage-tag');
        tag.setOrigin(0.5);
        container.add(tag);
      } else {
        tag.setText(u.damage);
      }
    }
  }

  private startPlayback(): void {
    this.playing = true;
    this.scheduleStep();
    this.refreshOverlay();
  }

  private togglePlay(): void {
    this.playing = !this.playing;
    if (this.playing) this.scheduleStep();
    else if (this.stepEvent) {
      this.stepEvent.remove();
      this.stepEvent = null;
    }
    this.refreshOverlay();
  }

  private scheduleStep(): void {
    if (!this.log) return;
    if (this.stepEvent) return;
    if (this.pendingTween > 0) return;
    this.stepEvent = this.time.delayedCall(STEP_INTERVAL_MS, () => {
      this.stepEvent = null;
      this.advanceOne();
    });
  }

  private advanceOne(): void {
    if (!this.log) return;
    if (!this.playing) return;
    if (this.commandIndex >= this.log.commands.length) {
      this.playing = false;
      this.appendLog('— end of replay —');
      this.refreshOverlay();
      return;
    }
    const cmd = this.log.commands[this.commandIndex]!;
    this.commandIndex += 1;
    try {
      const result = applyCommand(this.gameState, cmd);
      this.gameState = result.state;
      for (const ev of result.events) this.appendLog(formatEvent(ev));
      this.renderUnits();
      let cameraTarget: Vec2 | null = null;
      for (const ev of result.events) {
        if (ev.type === 'MOVE_RESOLVED') {
          this.animateMove(ev.unitId, ev.to);
          cameraTarget = ev.to;
        }
      }
      const act = this.gameState.initiative.activeActivation;
      if (!cameraTarget && act) {
        const u = this.gameState.units.find((x) => x.id === act.unitId);
        if (u) cameraTarget = u.position;
      }
      if (cameraTarget) this.panCameraTo(cameraTarget);
    } catch (e) {
      const message = e instanceof CommandError ? e.message : String(e);
      this.appendLog(`✗ replay error: ${message}`);
      this.playing = false;
    }
    this.refreshOverlay();
    if (this.playing && this.pendingTween === 0) this.scheduleStep();
  }

  private animateMove(unitId: string, to: Vec2): void {
    const container = this.unitContainers.get(unitId);
    if (!container) return;
    const dist = Math.hypot(to.x - container.x, to.y - container.y);
    if (dist < 0.5) return;
    const duration = Math.max(140, (dist / UNIT_DISTANCE_PIXELS) * 220);
    this.pendingTween++;
    this.tweens.add({
      targets: container,
      x: to.x,
      y: to.y,
      duration,
      ease: 'Sine.InOut',
      onComplete: () => {
        this.pendingTween = Math.max(0, this.pendingTween - 1);
        if (this.playing && this.pendingTween === 0) this.scheduleStep();
      },
    });
  }

  private panCameraTo(target: Vec2): void {
    this.cameras.main.pan(target.x, target.y, 400, 'Sine.easeInOut', true);
  }

  private makeOverlay(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'replay-overlay';
    el.style.position = 'absolute';
    el.style.top = '0';
    el.style.left = '0';
    el.style.right = '0';
    el.style.padding = '8px 16px';
    el.style.background = 'rgba(10, 14, 10, 0.85)';
    el.style.borderBottom = '1px solid #2a3a2a';
    el.style.fontSize = '13px';
    el.style.color = '#cfe8cf';
    el.style.zIndex = '12';
    el.style.display = 'flex';
    el.style.gap = '12px';
    el.style.alignItems = 'center';
    el.innerHTML = `
      <strong>Replay</strong>
      <span id="replay-progress">0/0</span>
      <button id="replay-toggle" style="padding:4px 10px;background:#1a2a1a;color:#cfe8cf;border:1px solid #3a5a3a;cursor:pointer;font-family:inherit;">Pause</button>
      <button id="replay-back" style="padding:4px 10px;background:#1a2a1a;color:#cfe8cf;border:1px solid #3a5a3a;cursor:pointer;font-family:inherit;">Back to Battle (ESC)</button>
      <span style="margin-left:auto;font-size:11px;color:#7a9a7a;">Space = play/pause</span>
    `;
    document.body.appendChild(el);
    el.querySelector<HTMLButtonElement>('#replay-toggle')?.addEventListener(
      'click',
      () => this.togglePlay(),
    );
    el.querySelector<HTMLButtonElement>('#replay-back')?.addEventListener(
      'click',
      () => this.exitToBattle(),
    );

    // Hide the battle HUD while in replay scene.
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = 'none';
    const frame = document.getElementById('hud-frame');
    if (frame) (frame as HTMLElement).style.display = 'none';

    return el;
  }

  private refreshOverlay(): void {
    const total = this.log?.commands.length ?? 0;
    const progress = this.overlayEl.querySelector('#replay-progress');
    if (progress) progress.textContent = `${this.commandIndex}/${total}`;
    const toggle = this.overlayEl.querySelector('#replay-toggle');
    if (toggle) toggle.textContent = this.playing ? 'Pause' : 'Play';
  }

  private appendLog(line: string): void {
    this.logLines.push(line);
    while (this.logLines.length > 4) this.logLines.shift();
    // Render a small log strip at the bottom.
    let logEl = document.getElementById('replay-log');
    if (!logEl) {
      logEl = document.createElement('div');
      logEl.id = 'replay-log';
      logEl.style.position = 'absolute';
      logEl.style.bottom = '0';
      logEl.style.left = '0';
      logEl.style.right = '0';
      logEl.style.padding = '8px 16px';
      logEl.style.background = 'rgba(10, 14, 10, 0.85)';
      logEl.style.borderTop = '1px solid #2a3a2a';
      logEl.style.fontSize = '12px';
      logEl.style.lineHeight = '1.5';
      logEl.style.color = '#8aa28a';
      logEl.style.zIndex = '12';
      logEl.style.whiteSpace = 'pre-wrap';
      document.body.appendChild(logEl);
    }
    logEl.textContent = this.logLines.join('\n');
  }

  private exitToBattle(): void {
    document.getElementById('replay-log')?.remove();
    this.overlayEl?.remove();
    this.scene.start('Roster');
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const formatEvent = (e: GameEvent): string => {
  switch (e.type) {
    case 'MOMENTUM_SPENT':
      return `· ${e.faction} spent ${e.amount} momentum`;
    case 'OVERDRAFT_DECLARED':
      return `· ${e.unitId} overdrafted (deficit ${e.deficit})`;
    case 'ACTIVATION_BEGAN':
      return `▶ ${e.unitId} activated (${e.kind})`;
    case 'ACTIVATION_CHECK_ROLLED':
      return `🎲 ${e.unitId} ${e.threshold}+ → ${e.roll} ${e.success ? '✓' : '✗'}`;
    case 'ACTIVATION_ENDED':
      return `■ ${e.unitId} end (${e.reason})`;
    case 'INITIATIVE_TURNOVER':
      return `↔ ${e.from}→${e.to} (${e.reason}, +${e.momentumGranted})`;
    case 'MOVE_RESOLVED':
      return `→ ${e.unitId} ${e.distance.toFixed(0)}px (${e.stopReason})`;
    case 'SHOT_RESOLVED':
      return `🔫 ${e.shooterId} → ${e.targetId} ${e.hits}/${e.diceCount}h ${e.beforeDamage}→${e.afterDamage}`;
    case 'MELEE_RESOLVED':
      return `⚔ ${e.attackerId} vs ${e.defenderId} → ${e.winnerId}`;
    case 'RALLY_ROLLED':
      return `🎯 ${e.unitId} ${e.threshold}+ → ${e.roll} ${e.success ? `${e.beforeDamage}→${e.afterDamage}` : '✗'}`;
  }
};
