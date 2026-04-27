import Phaser from 'phaser';
import { chooseAiCommand } from '../../ai/controller';
import { applyCommand } from '../../core/commands/reducer';
import type {
  Command,
  GameEvent,
  ReactionMarker,
  ReactionPlan,
  ShootMode,
} from '../../core/commands/types';
import { CommandError } from '../../core/commands/types';
import { hasLOS } from '../../core/geometry/los';
import {
  computeReactionWindows,
  type ReactionWindow,
} from '../../core/geometry/los_window';
import { computeMovePath } from '../../core/geometry/path';
import type { Vec2 } from '../../core/geometry/types';
import { v2Dist, v2Lerp } from '../../core/geometry/vec2';
import { listAvailableShootModes } from '../../core/resolution/shoot_modes';
import { UNIT_DISTANCE_PIXELS } from '../../core/rules/constants';
import type { GameState, Terrain, Unit } from '../../core/state/GameState';
import { getUnitCircle, isUnitAlive } from '../../core/state/GameState';
import timersConfig from '../../config/timers.json';
import type {
  ActionRequest,
  AimMode,
  HudContext,
  MeleeContext,
  ReactionContext,
  ShootContext,
} from '../ui/Hud';
import { Hud } from '../ui/Hud';
import {
  BATTLEFIELD_SIZE_PIXELS,
  setupDemoState,
} from '../state/setupBattleState';

const FACTION_COLOR: Readonly<Record<'A' | 'B', number>> = {
  A: 0x4a8acf,
  B: 0xcf5a4a,
};

const TERRAIN_COLOR: Readonly<Record<'HARD' | 'DIFFICULT' | 'SOFT', number>> = {
  HARD: 0x4a4a4a,
  DIFFICULT: 0x3a4a3a,
  SOFT: 0x6a6a8a,
};

const TERRAIN_ALPHA: Readonly<Record<'HARD' | 'DIFFICULT' | 'SOFT', number>> = {
  HARD: 1,
  DIFFICULT: 0.6,
  SOFT: 0.4,
};

interface ReactionPhaseState {
  intent: 'MOVE' | 'RALLY';
  moverId: string;
  moverStart: Vec2;
  moverRadius: number;
  moverFaction: 'A' | 'B';
  pathTarget: Vec2;
  pathEndpoint: Vec2;
  windows: ReactionWindow[];
  markers: ReactionMarker[];
  scrubberT: number;
}

export class BattleScene extends Phaser.Scene {
  private gameState!: GameState;
  private terrainGfx!: Phaser.GameObjects.Graphics;
  private boardEdgeGfx!: Phaser.GameObjects.Graphics;
  private aimGfx!: Phaser.GameObjects.Graphics;
  private unitLayer!: Phaser.GameObjects.Container;
  private selectedUnitId: string | null = null;
  private hud!: Hud;
  private aimMode: AimMode = 'idle';
  private reaction: ReactionPhaseState | null = null;
  /** Persistent per-unit Container for tween-able position updates. */
  private unitContainers = new Map<string, Phaser.GameObjects.Container>();
  private movementTweens = 0;
  private aiControlled: Record<'A' | 'B', boolean> = { A: false, B: false };
  private aiPending = false;
  private aiTickEvent: Phaser.Time.TimerEvent | null = null;
  private aiActiveUnitId: string | null = null;
  private aiActionsThisActivation = 0;
  private currentTimer: {
    phase: string;
    startMs: number;
    durationMs: number;
    onExpire: () => void;
  } | null = null;
  private timerEvent: Phaser.Time.TimerEvent | null = null;

  constructor() {
    super({ key: 'Battle' });
  }

  create(): void {
    this.gameState = setupDemoState();
    this.cameras.main.setBackgroundColor('#0a0c0a');

    this.boardEdgeGfx = this.add.graphics();
    this.terrainGfx = this.add.graphics();
    this.unitLayer = this.add.container();
    this.aimGfx = this.add.graphics();

    this.fitCamera();
    this.scale.on('resize', () => this.fitCamera());

    this.renderTerrain();
    this.renderUnits();

    this.input.mouse?.disableContextMenu();
    this.input.on('pointermove', this.onPointerMove, this);
    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.keyboard?.on('keydown-ESC', () => {
      // Reaction phase is intentionally not cancellable — handoff is final.
      if (this.aimMode === 'aim-move') this.cancelAim();
      else if (this.aimMode === 'aim-shoot' || this.aimMode === 'aim-melee')
        this.cancelAim();
    });

    this.hud = new Hud(
      (cmd) => this.dispatch(cmd),
      (req) => this.handleActionRequest(req),
      (idx) => this.removeMarker(idx),
      (t) => this.onScrubberChange(t),
      (shooterId, mode, parts) =>
        this.tryAddReactionMarker(shooterId, mode, parts),
      (faction, enabled) => {
        this.aiControlled[faction] = enabled;
        if (!enabled) this.cancelAiTick();
        this.maybeScheduleAiTick();
      },
    );
    this.refreshHud();
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
    this.drawBoardEdge();
  }

  private drawBoardEdge(): void {
    this.boardEdgeGfx.clear();
    this.boardEdgeGfx.lineStyle(2, 0x2a3a2a);
    this.boardEdgeGfx.strokeRect(
      0,
      0,
      BATTLEFIELD_SIZE_PIXELS,
      BATTLEFIELD_SIZE_PIXELS,
    );
  }

  private renderTerrain(): void {
    this.terrainGfx.clear();
    for (const t of this.gameState.terrain) this.drawTerrain(t);
  }

  private drawTerrain(t: Terrain): void {
    const verts = t.polygon.vertices;
    if (verts.length === 0) return;
    this.terrainGfx.fillStyle(TERRAIN_COLOR[t.kind], TERRAIN_ALPHA[t.kind]);
    this.terrainGfx.lineStyle(1, 0x6a6a6a, 1);
    this.terrainGfx.beginPath();
    this.terrainGfx.moveTo(verts[0]!.x, verts[0]!.y);
    for (let i = 1; i < verts.length; i++) {
      this.terrainGfx.lineTo(verts[i]!.x, verts[i]!.y);
    }
    this.terrainGfx.closePath();
    this.terrainGfx.fillPath();
    this.terrainGfx.strokePath();
  }

  private renderUnits(): void {
    const aliveIds = new Set<string>();
    for (const u of this.gameState.units) {
      if (isUnitAlive(u)) aliveIds.add(u.id);
    }
    // Destroy containers for dead/missing units.
    for (const [id, container] of [...this.unitContainers]) {
      if (!aliveIds.has(id)) {
        container.destroy();
        this.unitContainers.delete(id);
      }
    }
    // Create or update.
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
    arc.setInteractive({ useHandCursor: true });
    arc.on(
      'pointerdown',
      (
        _p: Phaser.Input.Pointer,
        _x: number,
        _y: number,
        ev: Phaser.Types.Input.EventData,
      ) => {
        if (this.aimMode === 'reaction-phase') {
          ev.stopPropagation();
          this.tryAddReactionMarker(u.id);
          return;
        }
        if (this.aimMode !== 'idle') return;
        ev.stopPropagation();
        this.selectUnit(u.id);
      },
    );
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

    const isSelected = this.selectedUnitId === u.id;
    const isActive =
      this.gameState.initiative.activeActivation?.unitId === u.id;

    let strokeColor = 0xffffff;
    let strokeWidth = 1.5;
    if (isSelected) {
      strokeColor = 0xffd166;
      strokeWidth = 3;
    } else if (isActive) {
      strokeColor = 0x9af09a;
      strokeWidth = 2.5;
    }
    if (this.aimMode === 'reaction-phase' && this.reaction) {
      if (u.faction !== this.reaction.moverFaction) {
        const visible = this.enemyVisibleAtCurrentScrubber(u);
        const committed = this.getCommittedReactorSet();
        const usable =
          visible &&
          !u.cannotReactThisRound &&
          u.damage !== 'SUPPRESSED' &&
          !committed.has(u.id);
        if (usable) {
          strokeColor = 0x9af09a;
          strokeWidth = 3;
        } else {
          strokeColor = 0x664444;
          strokeWidth = 1.5;
        }
      }
    }
    arc.setStrokeStyle(strokeWidth, strokeColor);

    // Damage tag (optional child).
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

  private getCommittedReactorSet(): Set<string> {
    const s = new Set<string>();
    if (!this.reaction) return s;
    for (const m of this.reaction.markers) {
      s.add(m.shooterId);
      for (const pid of m.participantIds) s.add(pid);
    }
    return s;
  }

  private startTimer(
    phase: string,
    seconds: number,
    onExpire: () => void,
  ): void {
    this.clearTimer();
    if (!timersConfig.enabled) return;
    const durationMs = seconds * 1000;
    this.currentTimer = {
      phase,
      startMs: this.time.now,
      durationMs,
      onExpire,
    };
    this.timerEvent = this.time.delayedCall(durationMs, () => {
      if (!this.currentTimer) return;
      const cb = this.currentTimer.onExpire;
      this.currentTimer = null;
      this.timerEvent = null;
      this.hud.hideTimer();
      cb();
    });
  }

  private clearTimer(): void {
    if (this.timerEvent) {
      this.timerEvent.remove();
      this.timerEvent = null;
    }
    this.currentTimer = null;
    if (this.hud) this.hud.hideTimer();
  }

  override update(_time: number): void {
    if (!this.hud) return;
    const operator = this.currentOperatorFaction();
    if (this.currentTimer) {
      const elapsed = this.time.now - this.currentTimer.startMs;
      const fraction = Math.max(
        0,
        1 - elapsed / this.currentTimer.durationMs,
      );
      const left = Math.max(0, (this.currentTimer.durationMs - elapsed) / 1000);
      this.hud.setFrame(operator, fraction);
      this.hud.setTimer(this.currentTimer.phase, left);
    } else {
      // No timer — static border in operator's color.
      this.hud.setFrame(operator);
    }
  }

  private currentOperatorFaction(): 'A' | 'B' {
    if (this.reaction) {
      return this.reaction.moverFaction === 'A' ? 'B' : 'A';
    }
    return this.gameState.initiative.holder;
  }

  private selectUnit(id: string | null): void {
    if (this.selectedUnitId === id) return;
    this.selectedUnitId = id;
    this.renderUnits();
    this.refreshHud();
  }

  private dispatch(cmd: Command): void {
    if (this.movementTweens > 0) {
      this.hud.pushError('Animation in progress, please wait');
      return;
    }
    this.clearTimer();
    try {
      const result = applyCommand(this.gameState, cmd);
      this.gameState = result.state;
      this.hud.pushEvents(result.events);
      if (this.aimMode === 'aim-shoot' || this.aimMode === 'aim-melee') {
        this.aimMode = 'idle';
      }
      this.refreshHud();
      this.renderUnits();
      // Animate any moves and overlay any dice rolls.
      let overlayIndex = 0;
      for (const ev of result.events) {
        if (ev.type === 'MOVE_RESOLVED') {
          this.animateMove(ev.unitId, ev.to);
        }
        if (this.isRollEvent(ev)) {
          this.showRollOverlay(ev, overlayIndex++);
        }
      }
      this.maybeScheduleAiTick();
    } catch (e) {
      const message = e instanceof CommandError ? e.message : String(e);
      this.hud.pushError(message);
    }
  }

  /**
   * Schedule an AI tick if the current holder is AI-controlled and we're not
   * busy with animation or aiming. If we're stuck in a reaction phase where
   * the defender is AI, auto-confirm with an empty plan instead.
   */
  private maybeScheduleAiTick(): void {
    if (this.aiPending) return;
    if (this.movementTweens > 0) return;
    if (this.aimMode === 'aim-move') return;
    if (this.aimMode === 'aim-shoot' || this.aimMode === 'aim-melee') return;

    if (this.aimMode === 'reaction-phase' && this.reaction) {
      const defender = this.reaction.moverFaction === 'A' ? 'B' : 'A';
      if (this.aiControlled[defender]) {
        this.aiPending = true;
        this.aiTickEvent = this.time.delayedCall(300, () => {
          this.aiPending = false;
          this.aiTickEvent = null;
          if (this.reaction) {
            this.reaction.markers = [];
            this.confirmReaction();
          }
        });
      }
      return;
    }

    if (this.aimMode !== 'idle') return;
    const holder = this.gameState.initiative.holder;
    if (!this.aiControlled[holder]) return;

    // Reset counter when the active unit changes (or no active activation).
    const curActiveId = this.gameState.initiative.activeActivation?.unitId ?? null;
    if (curActiveId !== this.aiActiveUnitId) {
      this.aiActiveUnitId = curActiveId;
      this.aiActionsThisActivation = 0;
    }

    this.aiPending = true;
    this.aiTickEvent = this.time.delayedCall(600, () => {
      this.aiPending = false;
      this.aiTickEvent = null;
      const cmd = chooseAiCommand(
        this.gameState,
        holder,
        this.aiActionsThisActivation,
      );
      if (!cmd) return;
      if (this.isActionCommand(cmd)) this.aiActionsThisActivation += 1;
      this.dispatch(cmd);
    });
  }

  private cancelAiTick(): void {
    if (this.aiTickEvent) {
      this.aiTickEvent.remove();
      this.aiTickEvent = null;
    }
    this.aiPending = false;
  }

  private isActionCommand(cmd: Command): boolean {
    return (
      cmd.type === 'MOVE' ||
      cmd.type === 'SHOOT' ||
      cmd.type === 'MELEE' ||
      cmd.type === 'RALLY'
    );
  }

  private animateMove(unitId: string, to: Vec2): void {
    const container = this.unitContainers.get(unitId);
    if (!container) return;
    const dx = to.x - container.x;
    const dy = to.y - container.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) return;
    const duration = Math.max(140, (dist / UNIT_DISTANCE_PIXELS) * 220);
    this.movementTweens++;
    this.tweens.add({
      targets: container,
      x: to.x,
      y: to.y,
      duration,
      ease: 'Sine.InOut',
      onComplete: () => {
        this.movementTweens = Math.max(0, this.movementTweens - 1);
        if (this.movementTweens === 0) this.maybeScheduleAiTick();
      },
    });
  }

  private isRollEvent(ev: GameEvent): boolean {
    return (
      ev.type === 'ACTIVATION_CHECK_ROLLED' ||
      ev.type === 'SHOT_RESOLVED' ||
      ev.type === 'MELEE_RESOLVED' ||
      ev.type === 'RALLY_ROLLED'
    );
  }

  private showRollOverlay(ev: GameEvent, stackIndex: number): void {
    let text = '';
    let unitId = '';
    let color = '#ffd166';
    switch (ev.type) {
      case 'ACTIVATION_CHECK_ROLLED':
        text = `${ev.threshold}+ → ${ev.roll} ${ev.success ? '✓' : '✗'}`;
        unitId = ev.unitId;
        color = ev.success ? '#9af09a' : '#ff8a6a';
        break;
      case 'SHOT_RESOLVED':
        text = `${ev.hits}/${ev.diceCount}h vs ${ev.threshold}+`;
        unitId = ev.shooterId;
        color = ev.hits > 0 ? '#9af09a' : '#ff8a6a';
        break;
      case 'MELEE_RESOLVED':
        text = `${ev.attackerHits}-${ev.defenderHits} → ${ev.winnerId}`;
        unitId = ev.attackerId;
        color = ev.winnerId === ev.attackerId ? '#9af09a' : '#ff8a6a';
        break;
      case 'RALLY_ROLLED':
        text = `${ev.threshold}+ → ${ev.roll} ${ev.success ? '✓' : '✗'}`;
        unitId = ev.unitId;
        color = ev.success ? '#9af09a' : '#ff8a6a';
        break;
      default:
        return;
    }
    const container = this.unitContainers.get(unitId);
    const u = this.gameState.units.find((x) => x.id === unitId);
    let x: number;
    let y: number;
    if (container) {
      x = container.x;
      y = container.y;
    } else if (u) {
      x = u.position.x;
      y = u.position.y;
    } else {
      return;
    }
    const radius = u?.radius ?? 12;
    const yStart = y - radius - 18 - stackIndex * 18;
    const txt = this.add.text(x, yStart, text, {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '14px',
      color,
      stroke: '#000000',
      strokeThickness: 3,
      fontStyle: 'bold',
    });
    txt.setOrigin(0.5);
    this.tweens.add({
      targets: txt,
      y: yStart - 26,
      alpha: 0,
      duration: 1500,
      ease: 'Cubic.Out',
      onComplete: () => txt.destroy(),
    });
  }

  private refreshHud(): void {
    const ctx: HudContext = {
      reaction: this.buildReactionContext(),
      shoot: this.buildShootContext(),
      melee: this.buildMeleeContext(),
    };
    this.hud.update(this.gameState, this.selectedUnitId, this.aimMode, ctx);
  }

  private buildReactionContext(): ReactionContext | undefined {
    if (!this.reaction) return undefined;
    const r = this.reaction;
    // Any unit already committed to a placed marker (as shooter OR
    // participant) is consumed for this reaction round and must not appear
    // in subsequent options.
    const committed = new Set<string>();
    for (const m of r.markers) {
      committed.add(m.shooterId);
      for (const pid of m.participantIds) committed.add(pid);
    }
    const reactors = this.gameState.units
      .filter(
        (u) =>
          u.faction !== r.moverFaction &&
          isUnitAlive(u) &&
          u.damage !== 'SUPPRESSED' &&
          !u.cannotReactThisRound &&
          !committed.has(u.id) &&
          this.enemyVisibleAtCurrentScrubber(u),
      )
      .map((shooter) => {
        const modes = listAvailableShootModes(
          this.virtualStateForReactor(),
          shooter.id,
          r.moverId,
          'REACTION',
          committed,
        );
        return {
          id: shooter.id,
          note: `(q${shooter.quality}+${shooter.damage !== 'NONE' ? `, ${shooter.damage}` : ''})`,
          modes: modes.map((m) => ({
            mode: m.mode,
            participantIds: m.participantIds,
            totalDice: m.totalDice,
          })),
        };
      })
      .filter((r) => r.modes.length > 0);
    return {
      defenderFaction: r.moverFaction === 'A' ? 'B' : 'A',
      intent: r.intent,
      markers: r.markers,
      currentT: r.scrubberT,
      visibleReactors: reactors,
    };
  }

  /**
   * For LOS/mode computation during reaction phase, the mover is conceptually
   * at the scrubber position rather than its current GameState position.
   * Build a virtual state with the mover repositioned for those checks.
   */
  private virtualStateForReactor(): GameState {
    if (!this.reaction) return this.gameState;
    const r = this.reaction;
    const moverPos = v2Lerp(r.moverStart, r.pathEndpoint, r.scrubberT);
    return {
      ...this.gameState,
      units: this.gameState.units.map((u) =>
        u.id === r.moverId ? { ...u, position: moverPos } : u,
      ),
    };
  }

  private buildShootContext(): ShootContext | undefined {
    const act = this.gameState.initiative.activeActivation;
    if (!act) return undefined;
    const shooter = this.gameState.units.find((u) => u.id === act.unitId);
    if (!shooter || !isUnitAlive(shooter)) return undefined;
    if (shooter.damage === 'SUPPRESSED') return undefined;
    const candidates = this.gameState.units
      .filter(
        (u) =>
          u.faction !== shooter.faction && isUnitAlive(u),
      )
      .map((target) => {
        const modes = listAvailableShootModes(
          this.gameState,
          shooter.id,
          target.id,
          'ACTIVE',
        );
        return {
          targetId: target.id,
          note: `(q${target.quality}+${target.damage !== 'NONE' ? `, ${target.damage}` : ''})`,
          modes: modes.map((m) => ({
            mode: m.mode,
            participantIds: m.participantIds,
            totalDice: m.totalDice,
          })),
        };
      })
      .filter((c) => c.modes.length > 0);
    return { shooterId: shooter.id, candidates };
  }

  private buildMeleeContext(): MeleeContext | undefined {
    const act = this.gameState.initiative.activeActivation;
    if (!act) return undefined;
    const attacker = this.gameState.units.find((u) => u.id === act.unitId);
    if (!attacker || !isUnitAlive(attacker)) return undefined;
    if (attacker.damage === 'SUPPRESSED') return undefined;
    const candidates = this.gameState.units
      .filter(
        (u) =>
          u.faction !== attacker.faction &&
          isUnitAlive(u) &&
          v2Dist(u.position, attacker.position) <=
            attacker.radius + u.radius + 2,
      )
      .map((target) => ({
        targetId: target.id,
        note: `(q${target.quality}+${target.damage !== 'NONE' ? `, ${target.damage}` : ''})`,
      }));
    return { attackerId: attacker.id, candidates };
  }

  private handleActionRequest(req: ActionRequest): void {
    switch (req) {
      case 'CANCEL_AIM':
        this.cancelAim();
        return;
      case 'REQUEST_MOVE': {
        const act = this.gameState.initiative.activeActivation;
        if (!act) return;
        this.aimMode = 'aim-move';
        this.refreshHud();
        this.startTimer('Move target', timersConfig.moveTargetSeconds, () =>
          this.cancelAim(),
        );
        return;
      }
      case 'REQUEST_RALLY': {
        const act = this.gameState.initiative.activeActivation;
        if (!act) return;
        this.enterRallyReactionPhase();
        return;
      }
      case 'REQUEST_SHOOT': {
        const act = this.gameState.initiative.activeActivation;
        if (!act) return;
        this.aimMode = 'aim-shoot';
        this.refreshHud();
        this.startTimer('Pick target', timersConfig.shootPickerSeconds, () =>
          this.cancelAim(),
        );
        return;
      }
      case 'REQUEST_MELEE': {
        const act = this.gameState.initiative.activeActivation;
        if (!act) return;
        this.aimMode = 'aim-melee';
        this.refreshHud();
        this.startTimer('Pick target', timersConfig.meleePickerSeconds, () =>
          this.cancelAim(),
        );
        return;
      }
      case 'CONFIRM_REACTION':
        this.confirmReaction();
        return;
      case 'SKIP_REACTION':
        if (this.reaction) this.reaction.markers = [];
        this.confirmReaction();
        return;
    }
  }

  private cancelAim(): void {
    this.aimMode = 'idle';
    this.aimGfx.clear();
    this.clearTimer();
    this.refreshHud();
  }


  private removeMarker(index: number): void {
    if (!this.reaction) return;
    this.reaction.markers = this.reaction.markers.filter((_, i) => i !== index);
    this.drawReactionPreview();
    this.refreshHud();
  }

  private onScrubberChange(t: number): void {
    if (!this.reaction) return;
    this.reaction.scrubberT = t;
    this.drawReactionPreview();
    this.renderUnits();
    this.refreshHud();
  }

  private confirmReaction(): void {
    if (!this.reaction) return;
    const r = this.reaction;
    this.reaction = null;
    this.aimMode = 'idle';
    this.aimGfx.clear();
    const plan: ReactionPlan = { markers: r.markers };
    if (r.intent === 'MOVE') {
      this.dispatch({
        type: 'MOVE',
        unitId: r.moverId,
        target: r.pathTarget,
        reactionPlan: plan,
      });
    } else {
      this.dispatch({
        type: 'RALLY',
        unitId: r.moverId,
        reactionPlan: plan,
      });
    }
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.aimMode !== 'aim-move') return;
    const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.updateMovePreview({ x: wp.x, y: wp.y });
  }

  private onPointerDown(
    pointer: Phaser.Input.Pointer,
    targets: unknown[],
  ): void {
    if (this.aimMode === 'aim-move') {
      if (pointer.rightButtonDown()) {
        this.cancelAim();
        return;
      }
      const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.enterReactionPhase({ x: wp.x, y: wp.y });
      return;
    }
    if (this.aimMode === 'reaction-phase') return;
    if (this.aimMode === 'aim-shoot' || this.aimMode === 'aim-melee') return;
    if (targets.length === 0) this.selectUnit(null);
  }

  private enterReactionPhase(target: Vec2): void {
    const act = this.gameState.initiative.activeActivation;
    if (!act) {
      this.cancelAim();
      return;
    }
    const u = this.gameState.units.find((x) => x.id === act.unitId);
    if (!u) {
      this.cancelAim();
      return;
    }

    const hardObs = this.gameState.terrain
      .filter((t) => t.kind === 'HARD')
      .map((t) => t.polygon);
    const enemyCircles = this.gameState.units
      .filter((o) => o.faction !== u.faction && isUnitAlive(o))
      .map(getUnitCircle);
    const path = computeMovePath(u.position, target, {
      polygons: hardObs,
      enemyCircles,
      moverRadius: u.radius,
    });
    const enemies = this.gameState.units
      .filter((o) => o.faction !== u.faction && isUnitAlive(o))
      .map((o) => ({ id: o.id, circle: getUnitCircle(o) }));
    const windows = [
      ...computeReactionWindows(
        u.position,
        path.endpoint,
        u.radius,
        enemies,
        hardObs,
      ),
    ];

    this.reaction = {
      intent: 'MOVE',
      moverId: u.id,
      moverStart: { ...u.position },
      moverRadius: u.radius,
      moverFaction: u.faction,
      pathTarget: target,
      pathEndpoint: path.endpoint,
      windows,
      markers: [],
      scrubberT: 0,
    };
    this.aimMode = 'reaction-phase';
    this.hud.setScrubberValue(0);
    this.drawReactionPreview();
    this.renderUnits();
    this.refreshHud();
    this.startTimer(
      'Reaction',
      timersConfig.reactionPhaseSeconds,
      () => this.confirmReaction(),
    );
    this.maybeScheduleAiTick();
  }

  private enterRallyReactionPhase(): void {
    const act = this.gameState.initiative.activeActivation;
    if (!act) return;
    const u = this.gameState.units.find((x) => x.id === act.unitId);
    if (!u) return;
    if (u.damage === 'NONE') {
      this.hud.pushError(`${u.id} has nothing to rally`);
      return;
    }

    this.reaction = {
      intent: 'RALLY',
      moverId: u.id,
      moverStart: { ...u.position },
      moverRadius: u.radius,
      moverFaction: u.faction,
      pathTarget: { ...u.position },
      pathEndpoint: { ...u.position },
      windows: [],
      markers: [],
      scrubberT: 0,
    };
    this.aimMode = 'reaction-phase';
    this.hud.setScrubberValue(0);
    this.drawReactionPreview();
    this.renderUnits();
    this.refreshHud();
    this.startTimer(
      'Reaction',
      timersConfig.reactionPhaseSeconds,
      () => this.confirmReaction(),
    );
    this.maybeScheduleAiTick();
  }

  private tryAddReactionMarker(
    shooterId: string,
    mode: ShootMode = 'SOLO',
    participantIds: ReadonlyArray<string> = [],
  ): void {
    if (!this.reaction) return;
    const shooter = this.gameState.units.find((x) => x.id === shooterId);
    if (!shooter) return;
    if (shooter.faction === this.reaction.moverFaction) return;
    if (!isUnitAlive(shooter)) return;
    if (shooter.damage === 'SUPPRESSED') {
      this.hud.pushError(`${shooterId} is suppressed and cannot react`);
      return;
    }
    if (shooter.cannotReactThisRound) {
      this.hud.pushError(`${shooterId} already used reaction this round`);
      return;
    }
    if (!this.enemyVisibleAtCurrentScrubber(shooter)) {
      this.hud.pushError(
        `${shooterId} has no LOS at t=${this.reaction.scrubberT.toFixed(2)}`,
      );
      return;
    }
    const marker: ReactionMarker = {
      atT: this.reaction.scrubberT,
      shooterId,
      mode,
      participantIds: [...participantIds],
    };
    this.reaction.markers = [...this.reaction.markers, marker].sort(
      (a, b) => a.atT - b.atT,
    );
    this.drawReactionPreview();
    this.refreshHud();
  }

  private enemyVisibleAtCurrentScrubber(enemy: Unit): boolean {
    if (!this.reaction) return false;
    const moverPos = v2Lerp(
      this.reaction.moverStart,
      this.reaction.pathEndpoint,
      this.reaction.scrubberT,
    );
    const hardObs = this.gameState.terrain
      .filter((t) => t.kind === 'HARD')
      .map((t) => t.polygon);
    return hasLOS(
      getUnitCircle(enemy),
      { center: moverPos, radius: this.reaction.moverRadius },
      hardObs,
    );
  }

  private updateMovePreview(target: Vec2): void {
    this.aimGfx.clear();
    const act = this.gameState.initiative.activeActivation;
    if (!act) return;
    const u = this.gameState.units.find((x) => x.id === act.unitId);
    if (!u) return;

    const hardObs = this.gameState.terrain
      .filter((t) => t.kind === 'HARD')
      .map((t) => t.polygon);
    const enemyCircles = this.gameState.units
      .filter((o) => o.faction !== u.faction && isUnitAlive(o))
      .map(getUnitCircle);
    const path = computeMovePath(u.position, target, {
      polygons: hardObs,
      enemyCircles,
      moverRadius: u.radius,
    });

    const lineColor = path.stopReason === 'TARGET' ? 0x9af09a : 0xcfe8cf;
    const sameSpot =
      Math.abs(path.endpoint.x - u.position.x) < 0.01 &&
      Math.abs(path.endpoint.y - u.position.y) < 0.01;
    this.aimGfx.fillStyle(lineColor, 0.18);
    this.aimGfx.fillCircle(u.position.x, u.position.y, u.radius);
    if (!sameSpot) {
      this.aimGfx.fillCircle(path.endpoint.x, path.endpoint.y, u.radius);
      this.aimGfx.lineStyle(u.radius * 2, lineColor, 0.18);
      this.aimGfx.beginPath();
      this.aimGfx.moveTo(u.position.x, u.position.y);
      this.aimGfx.lineTo(path.endpoint.x, path.endpoint.y);
      this.aimGfx.strokePath();
    }
    this.aimGfx.lineStyle(1.5, lineColor, 0.9);
    this.aimGfx.beginPath();
    this.aimGfx.moveTo(u.position.x, u.position.y);
    this.aimGfx.lineTo(path.endpoint.x, path.endpoint.y);
    this.aimGfx.strokePath();

    const enemies = this.gameState.units
      .filter((o) => o.faction !== u.faction && isUnitAlive(o))
      .map((o) => ({ id: o.id, circle: getUnitCircle(o) }));
    const windows = computeReactionWindows(
      u.position,
      path.endpoint,
      u.radius,
      enemies,
      hardObs,
    );
    this.aimGfx.lineStyle(4, 0xff5555, 0.7);
    for (const w of windows) {
      const startP = v2Lerp(u.position, path.endpoint, w.startT);
      const endP = v2Lerp(u.position, path.endpoint, w.endT);
      this.aimGfx.beginPath();
      this.aimGfx.moveTo(startP.x, startP.y);
      this.aimGfx.lineTo(endP.x, endP.y);
      this.aimGfx.strokePath();
    }

    if (path.stopReason === 'OBSTACLE') {
      this.aimGfx.fillStyle(0xffaa55, 1);
      this.aimGfx.fillCircle(path.endpoint.x, path.endpoint.y, 5);
    } else if (path.stopReason === 'ENEMY') {
      this.aimGfx.fillStyle(0xff5555, 1);
      this.aimGfx.fillCircle(path.endpoint.x, path.endpoint.y, 5);
    }
    this.aimGfx.lineStyle(1.5, FACTION_COLOR[u.faction], 0.7);
    this.aimGfx.strokeCircle(path.endpoint.x, path.endpoint.y, u.radius);
  }

  private drawReactionPreview(): void {
    this.aimGfx.clear();
    if (!this.reaction) return;
    const r = this.reaction;
    const moverColor = FACTION_COLOR[r.moverFaction];

    if (r.intent === 'MOVE') {
      this.aimGfx.fillStyle(moverColor, 0.12);
      this.aimGfx.fillCircle(r.moverStart.x, r.moverStart.y, r.moverRadius);
      this.aimGfx.fillCircle(r.pathEndpoint.x, r.pathEndpoint.y, r.moverRadius);
      this.aimGfx.lineStyle(r.moverRadius * 2, moverColor, 0.12);
      this.aimGfx.beginPath();
      this.aimGfx.moveTo(r.moverStart.x, r.moverStart.y);
      this.aimGfx.lineTo(r.pathEndpoint.x, r.pathEndpoint.y);
      this.aimGfx.strokePath();

      this.aimGfx.lineStyle(1.5, 0xcfe8cf, 0.8);
      this.aimGfx.beginPath();
      this.aimGfx.moveTo(r.moverStart.x, r.moverStart.y);
      this.aimGfx.lineTo(r.pathEndpoint.x, r.pathEndpoint.y);
      this.aimGfx.strokePath();

      this.aimGfx.lineStyle(4, 0xff5555, 0.7);
      for (const w of r.windows) {
        const startP = v2Lerp(r.moverStart, r.pathEndpoint, w.startT);
        const endP = v2Lerp(r.moverStart, r.pathEndpoint, w.endT);
        this.aimGfx.beginPath();
        this.aimGfx.moveTo(startP.x, startP.y);
        this.aimGfx.lineTo(endP.x, endP.y);
        this.aimGfx.strokePath();
      }

      for (const m of r.markers) {
        const p = v2Lerp(r.moverStart, r.pathEndpoint, m.atT);
        this.aimGfx.fillStyle(0xffd166, 1);
        this.aimGfx.fillCircle(p.x, p.y, 5);
        this.aimGfx.lineStyle(1, 0x000000, 1);
        this.aimGfx.strokeCircle(p.x, p.y, 5);
      }

      const ghost = v2Lerp(r.moverStart, r.pathEndpoint, r.scrubberT);
      this.aimGfx.fillStyle(moverColor, 0.45);
      this.aimGfx.fillCircle(ghost.x, ghost.y, r.moverRadius);
      this.aimGfx.lineStyle(2, 0xffffff, 0.9);
      this.aimGfx.strokeCircle(ghost.x, ghost.y, r.moverRadius);
    } else {
      // RALLY: highlight the rallying unit; markers shown as a single dot.
      this.aimGfx.lineStyle(3, 0xffd166, 0.8);
      this.aimGfx.strokeCircle(r.moverStart.x, r.moverStart.y, r.moverRadius + 4);
      if (r.markers.length > 0) {
        this.aimGfx.fillStyle(0xffd166, 1);
        this.aimGfx.fillCircle(r.moverStart.x, r.moverStart.y, 5);
      }
    }
  }
}
