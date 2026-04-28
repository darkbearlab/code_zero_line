import Phaser from 'phaser';
import { chooseAiCommand } from '../../ai/controller';
import { applyCommand } from '../../core/commands/reducer';
import { isPointInPolygon } from '../../core/geometry/polygon';
import {
  climbDestination,
  vaultDestination,
} from '../../core/geometry/wallTraversal';
import { drawTerrain, polygonCentroid } from '../rendering/terrain';
import {
  appendCommand,
  createReplayLog,
  type ReplayLog,
} from '../../core/replay/log';
import { saveReplay } from '../../core/replay/storage';
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
import type { GameState, Unit } from '../../core/state/GameState';
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

interface ReactionPhaseState {
  intent: 'MOVE' | 'RALLY';
  /** Which command will be dispatched when the reaction phase confirms. */
  commandType: 'MOVE' | 'CRAWL' | 'VAULT' | 'CLIMB' | 'RALLY';
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

/** Visual-only meta about an in-flight move tween, used by auto-facing. */
interface ActiveMoveMeta {
  from: Vec2;
  to: Vec2;
  windows: ReadonlyArray<ReactionWindow>;
  tween: Phaser.Tweens.Tween;
}

export class BattleScene extends Phaser.Scene {
  private gameState!: GameState;
  private terrainGfx!: Phaser.GameObjects.Graphics;
  private terrainLabels: Phaser.GameObjects.Text[] = [];
  private boardEdgeGfx!: Phaser.GameObjects.Graphics;
  private aimGfx!: Phaser.GameObjects.Graphics;
  private unitLayer!: Phaser.GameObjects.Container;
  private selectedUnitId: string | null = null;
  private hud!: Hud;
  private aimMode: AimMode = 'idle';
  private reaction: ReactionPhaseState | null = null;
  /** Persistent per-unit Container for tween-able position updates. */
  private unitContainers = new Map<string, Phaser.GameObjects.Container>();
  /** Visual-only facing per unit, in radians (no rules effect). */
  private unitFacings = new Map<string, number>();
  /** Mid-aim-move drag state: target locked at press, angle from drag. */
  private moveFacingDrag: { target: Vec2; angle: number | null } | null = null;
  private pendingMoveStance: 'STANDING' | 'CRAWL' | null = null;
  private pendingEndProne = false;
  /** After dispatching MOVE, apply this facing on tween start. */
  private pendingMoverFacing: { unitId: string; angle: number } | null = null;
  /** Active move tweens used by per-frame auto-facing of LOS witnesses. */
  private activeMovesMeta = new Map<string, ActiveMoveMeta>();
  private movementTweens = 0;
  private aiControlled: Record<'A' | 'B', boolean> = { A: false, B: false };
  private aiPending = false;
  private aiTickEvent: Phaser.Time.TimerEvent | null = null;
  private aiActiveUnitId: string | null = null;
  private aiActionsThisActivation = 0;
  private replayLog!: ReplayLog;
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

  init(data: { initialState?: GameState }): void {
    if (data?.initialState) {
      this.gameState = data.initialState;
    } else {
      this.gameState = setupDemoState();
    }
    // Phaser reuses scene instances across scene.start() calls, so all stateful
    // fields must be reset here per match. Field initializers only run once.
    this.selectedUnitId = null;
    this.aimMode = 'idle';
    this.reaction = null;
    this.unitContainers = new Map();
    this.terrainLabels = [];
    this.unitFacings = new Map();
    this.moveFacingDrag = null;
    this.pendingMoverFacing = null;
    this.pendingMoveStance = null;
    this.pendingEndProne = false;
    this.activeMovesMeta = new Map();
    this.movementTweens = 0;
    this.aiControlled = { A: false, B: false };
    this.aiPending = false;
    this.aiTickEvent = null;
    this.aiActiveUnitId = null;
    this.aiActionsThisActivation = 0;
    this.victoryFired = false;
    this.currentTimer = null;
    this.timerEvent = null;
  }

  create(): void {
    showBattleHud();
    this.replayLog = createReplayLog(this.gameState);
    this.cameras.main.setBackgroundColor('#0a0c0a');

    this.boardEdgeGfx = this.add.graphics();
    this.terrainGfx = this.add.graphics();
    this.unitLayer = this.add.container();
    this.aimGfx = this.add.graphics();

    this.fitCamera();
    const resizeHandler = () => this.fitCamera();
    this.scale.on('resize', resizeHandler);
    this.events.once('shutdown', () => this.scale.off('resize', resizeHandler));

    this.renderTerrain();
    this.renderUnits();

    this.input.mouse?.disableContextMenu();
    this.input.on('pointermove', this.onPointerMove, this);
    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.on('pointerup', this.onPointerUp, this);
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
    // Destroy old terrain labels if any.
    for (const lbl of this.terrainLabels) lbl.destroy();
    this.terrainLabels = [];
    for (const t of this.gameState.terrain) {
      drawTerrain(this.terrainGfx, t);
      if (t.displayName) {
        const c = polygonCentroid(t.polygon.vertices);
        const lbl = this.add.text(c.x, c.y, t.displayName, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '9px',
          color: '#cfe8cf',
        });
        lbl.setOrigin(0.5);
        lbl.setAlpha(0.6);
        this.terrainLabels.push(lbl);
      }
    }
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

    // Facing chevron (purely cosmetic — not in GameState). Wrapped in a
    // sub-container so we can rotate around the unit's true center (0,0)
    // instead of the triangle's bounding-box center.
    const facingPivot = this.add.container(0, 0);
    const tri = this.add.triangle(
      0,
      0,
      u.radius * 1.45,
      0,
      -u.radius * 0.25,
      -u.radius * 0.5,
      -u.radius * 0.25,
      u.radius * 0.5,
      0xfff5cf,
    );
    tri.setAlpha(0.9);
    facingPivot.add(tri);
    facingPivot.setName('facing');
    container.add(facingPivot);

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

    // Default facing: A points up (-y), B points down (+y) — toward each
    // other given top/bottom deployment zones. Existing facing is preserved
    // when the container is recreated.
    const initial =
      this.unitFacings.get(u.id) ??
      (u.faction === 'A' ? -Math.PI / 2 : Math.PI / 2);
    this.unitFacings.set(u.id, initial);
    facingPivot.rotation = initial;

    return container;
  }

  private setUnitFacing(unitId: string, angle: number): void {
    this.unitFacings.set(unitId, angle);
    const c = this.unitContainers.get(unitId);
    if (!c) return;
    const chev = c.getByName('facing') as Phaser.GameObjects.Container | null;
    if (chev) chev.rotation = angle;
  }

  private faceUnitTowardPoint(unitId: string, target: Vec2): void {
    const u = this.gameState.units.find((x) => x.id === unitId);
    if (!u) return;
    const dx = target.x - u.position.x;
    const dy = target.y - u.position.y;
    if (Math.hypot(dx, dy) < 0.5) return;
    this.setUnitFacing(unitId, Math.atan2(dy, dx));
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

    // Prone visual: dim fill + show "PRONE" stance tag. Chevron also dims so
    // the unit reads as low-profile from above.
    const proneAlpha = u.stance === 'PRONE' ? 0.55 : 1;
    arc.setFillStyle(FACTION_COLOR[u.faction], proneAlpha);
    const facingPivot = container.getByName('facing') as
      | Phaser.GameObjects.Container
      | null;
    if (facingPivot) facingPivot.setAlpha(u.stance === 'PRONE' ? 0.45 : 0.9);

    let stanceTag = container.getByName('stance-tag') as
      | Phaser.GameObjects.Text
      | null;
    if (u.stance === 'PRONE') {
      if (!stanceTag) {
        stanceTag = this.add.text(0, u.radius + 14, 'PRONE', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '8px',
          color: '#ffae6a',
        });
        stanceTag.setName('stance-tag');
        stanceTag.setOrigin(0.5);
        container.add(stanceTag);
      }
    } else if (stanceTag) {
      stanceTag.destroy();
    }

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
    if (this.activeMovesMeta.size > 0) this.tickAutoFacing();
  }

  /**
   * Visual-only: while a unit is sliding along its move tween, any defender
   * whose LOS window covers the current t turns to face the mover. Uses the
   * precomputed reaction windows so this is O(windows) per frame, no LOS
   * calls in the hot loop.
   */
  private tickAutoFacing(): void {
    for (const info of this.activeMovesMeta.values()) {
      const t = info.tween.progress;
      const moverPos = v2Lerp(info.from, info.to, t);
      for (const w of info.windows) {
        if (t < w.startT || t > w.endT) continue;
        const def = this.gameState.units.find((x) => x.id === w.enemyUnitId);
        if (!def || !isUnitAlive(def)) continue;
        const angle = Math.atan2(
          moverPos.y - def.position.y,
          moverPos.x - def.position.x,
        );
        this.setUnitFacing(def.id, angle);
      }
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
      this.replayLog = appendCommand(this.replayLog, cmd);
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
          this.animateMove(ev.unitId, ev.from, ev.to, ev.reactionWindows);
        }
        if (ev.type === 'SHOT_RESOLVED') {
          const targetPos = this.gameState.units.find(
            (u) => u.id === ev.targetId,
          )?.position;
          if (targetPos) {
            this.faceUnitTowardPoint(ev.shooterId, targetPos);
            for (const pid of ev.participantIds) {
              this.faceUnitTowardPoint(pid, targetPos);
            }
          }
        }
        if (ev.type === 'MELEE_RESOLVED') {
          const att = this.gameState.units.find(
            (u) => u.id === ev.attackerId,
          );
          const def = this.gameState.units.find(
            (u) => u.id === ev.defenderId,
          );
          if (att) this.faceUnitTowardPoint(ev.attackerId, def?.position ?? att.position);
          if (def) this.faceUnitTowardPoint(ev.defenderId, att?.position ?? def.position);
        }
        if (this.isRollEvent(ev)) {
          this.showRollOverlay(ev, overlayIndex++);
        }
      }
      this.maybeScheduleAiTick();
      this.checkVictory();
    } catch (e) {
      const message = e instanceof CommandError ? e.message : String(e);
      this.hud.pushError(message);
    }
  }

  private victoryFired = false;
  private static readonly ROUND_LIMIT = 8;

  /**
   * Victory rules (Phase 9 v1):
   *  - Side has no living units → that side loses.
   *  - Side has living units but every one is SUPPRESSED → that side loses
   *    (treat as "no one able to act" — they cannot rally without RALLY which
   *    requires activation; for v1 we accept a soft check).
   *  - At round > ROUND_LIMIT, side with more living-and-not-suppressed units
   *    wins; tie → DRAW.
   */
  private checkVictory(): void {
    if (this.victoryFired) return;
    const counts = countSideHealth(this.gameState);
    let winner: 'A' | 'B' | 'DRAW' | null = null;
    if (counts.A.alive === 0 && counts.B.alive === 0) winner = 'DRAW';
    else if (counts.A.alive === 0) winner = 'B';
    else if (counts.B.alive === 0) winner = 'A';
    else if (this.gameState.initiative.round > BattleScene.ROUND_LIMIT) {
      const aScore = counts.A.alive - counts.A.suppressed;
      const bScore = counts.B.alive - counts.B.suppressed;
      if (aScore > bScore) winner = 'A';
      else if (bScore > aScore) winner = 'B';
      else winner = 'DRAW';
    }
    if (!winner) return;
    this.victoryFired = true;
    this.cancelAiTick();
    this.clearTimer();
    const summary = {
      winner,
      counts,
      finalRound: this.gameState.initiative.round,
      replayLog: this.replayLog,
    };
    this.time.delayedCall(800, () => this.scene.start('Result', summary));
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

  private animateMove(
    unitId: string,
    from: Vec2,
    to: Vec2,
    windows: ReadonlyArray<ReactionWindow>,
  ): void {
    const container = this.unitContainers.get(unitId);
    if (!container) return;
    const dx = to.x - container.x;
    const dy = to.y - container.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) return;

    // Drag-chosen facing applies at *end* of tween, so during motion the unit
    // visibly faces forward.
    let endFacing: number | null = null;
    if (
      this.pendingMoverFacing &&
      this.pendingMoverFacing.unitId === unitId
    ) {
      endFacing = this.pendingMoverFacing.angle;
      this.pendingMoverFacing = null;
    }
    if (Math.hypot(to.x - from.x, to.y - from.y) > 0.5) {
      this.setUnitFacing(
        unitId,
        Math.atan2(to.y - from.y, to.x - from.x),
      );
    }

    const duration = Math.max(140, (dist / UNIT_DISTANCE_PIXELS) * 220);
    this.movementTweens++;
    const tween = this.tweens.add({
      targets: container,
      x: to.x,
      y: to.y,
      duration,
      ease: 'Sine.InOut',
      onComplete: () => {
        this.movementTweens = Math.max(0, this.movementTweens - 1);
        this.activeMovesMeta.delete(unitId);
        if (endFacing !== null) this.setUnitFacing(unitId, endFacing);
        if (this.movementTweens === 0) this.maybeScheduleAiTick();
      },
    });
    this.activeMovesMeta.set(unitId, { from, to, windows, tween });
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
      traversal: this.buildTraversalContext(),
      movePreview: this.buildMovePreviewContext(),
    };
    this.hud.update(this.gameState, this.selectedUnitId, this.aimMode, ctx);
  }

  private buildMovePreviewContext():
    | import('../ui/Hud').MovePreviewContext
    | undefined {
    if (this.aimMode !== 'aim-move') return undefined;
    if (this.pendingMoveStance !== 'STANDING') {
      return { endProne: false, canEndProne: false };
    }
    const act = this.gameState.initiative.activeActivation;
    if (!act) return { endProne: false, canEndProne: false };
    const u = this.gameState.units.find((x) => x.id === act.unitId);
    if (!u) return { endProne: false, canEndProne: false };
    const inDifficult = this.gameState.terrain.some(
      (t) => t.kind === 'DIFFICULT' && isPointInPolygon(u.position, t.polygon),
    );
    return {
      endProne: this.pendingEndProne,
      canEndProne: !inDifficult,
    };
  }

  private buildTraversalContext():
    | import('../ui/Hud').TraversalContext
    | undefined {
    const act = this.gameState.initiative.activeActivation;
    if (!act) return undefined;
    const u = this.gameState.units.find((x) => x.id === act.unitId);
    if (!u || !isUnitAlive(u)) return undefined;
    if (u.damage !== 'NONE') return undefined;
    const wall = this.findContactedHardWallForUnit(u);
    if (!wall) return { canVault: false, canClimb: false };
    const isLow =
      wall.height !== undefined && wall.height <= UNIT_DISTANCE_PIXELS;
    return { canVault: isLow, canClimb: !isLow };
  }

  private findContactedHardWallForUnit(
    u: Unit,
  ): import('../../core/state/GameState').Terrain | null {
    const epsilon = 4;
    for (const t of this.gameState.terrain) {
      if (t.kind !== 'HARD') continue;
      const verts = t.polygon.vertices;
      for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
        const a = verts[j]!;
        const b = verts[i]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) continue;
        const tt = Math.max(
          0,
          Math.min(
            1,
            ((u.position.x - a.x) * dx + (u.position.y - a.y) * dy) / lenSq,
          ),
        );
        const px = a.x + dx * tt;
        const py = a.y + dy * tt;
        const dist = Math.hypot(u.position.x - px, u.position.y - py);
        if (dist <= u.radius + epsilon) return t;
      }
    }
    return null;
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
        this.aimMode = 'aim-move-stance';
        this.pendingMoveStance = null;
        this.pendingEndProne = false;
        this.refreshHud();
        return;
      }
      case 'TOGGLE_END_PRONE':
        this.pendingEndProne = !this.pendingEndProne;
        this.refreshHud();
        return;
      case 'CHOOSE_MOVE_STANDING': {
        if (this.aimMode !== 'aim-move-stance') return;
        this.pendingMoveStance = 'STANDING';
        this.aimMode = 'aim-move';
        this.refreshHud();
        this.startTimer('Move target', timersConfig.moveTargetSeconds, () =>
          this.cancelAim(),
        );
        return;
      }
      case 'CHOOSE_MOVE_CRAWL': {
        if (this.aimMode !== 'aim-move-stance') return;
        this.pendingMoveStance = 'CRAWL';
        this.aimMode = 'aim-move';
        this.refreshHud();
        this.startTimer('Move target', timersConfig.moveTargetSeconds, () =>
          this.cancelAim(),
        );
        return;
      }
      case 'REQUEST_VAULT': {
        const act = this.gameState.initiative.activeActivation;
        if (!act) return;
        this.enterVaultClimbReactionPhase('VAULT');
        return;
      }
      case 'REQUEST_CLIMB': {
        const act = this.gameState.initiative.activeActivation;
        if (!act) return;
        this.enterVaultClimbReactionPhase('CLIMB');
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
      case 'SAVE_REPLAY':
        this.saveCurrentReplay();
        return;
      case 'PLAY_LAST_REPLAY':
        this.scene.start('Replay');
        return;
      default:
        return;
    }
  }

  private saveCurrentReplay(): void {
    if (this.replayLog.commands.length === 0) {
      this.hud.pushError('No commands recorded yet');
      return;
    }
    const id = saveReplay(this.replayLog);
    this.hud.pushError(`Replay saved (${id}, ${this.replayLog.commands.length} commands)`);
  }

  private cancelAim(): void {
    this.aimMode = 'idle';
    this.aimGfx.clear();
    this.moveFacingDrag = null;
    this.pendingMoveStance = null;
    this.pendingEndProne = false;
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
    const stanceUsed = this.pendingMoveStance;
    const endProneUsed = this.pendingEndProne;
    this.pendingMoveStance = null;
    this.pendingEndProne = false;
    const plan: ReactionPlan = { markers: r.markers };
    switch (r.commandType) {
      case 'MOVE':
        this.dispatch({
          type: 'MOVE',
          unitId: r.moverId,
          target: r.pathTarget,
          reactionPlan: plan,
          endProne: endProneUsed,
        });
        break;
      case 'CRAWL':
        this.dispatch({
          type: 'CRAWL',
          unitId: r.moverId,
          target: r.pathTarget,
          reactionPlan: plan,
        });
        break;
      case 'VAULT':
        this.dispatch({
          type: 'VAULT',
          unitId: r.moverId,
          reactionPlan: plan,
        });
        break;
      case 'CLIMB':
        this.dispatch({
          type: 'CLIMB',
          unitId: r.moverId,
          reactionPlan: plan,
        });
        break;
      case 'RALLY':
        this.dispatch({
          type: 'RALLY',
          unitId: r.moverId,
          reactionPlan: plan,
        });
        break;
    }
    void stanceUsed;
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.aimMode !== 'aim-move') return;
    const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    if (this.moveFacingDrag) {
      const dx = wp.x - this.moveFacingDrag.target.x;
      const dy = wp.y - this.moveFacingDrag.target.y;
      const dist = Math.hypot(dx, dy);
      // Dead zone: small drags don't change angle (avoid jitter on click).
      this.moveFacingDrag.angle = dist > 6 ? Math.atan2(dy, dx) : null;
      this.updateMovePreview(this.moveFacingDrag.target);
    } else {
      this.updateMovePreview({ x: wp.x, y: wp.y });
    }
  }

  private onPointerDown(
    pointer: Phaser.Input.Pointer,
    targets: unknown[],
  ): void {
    if (this.aimMode === 'aim-move') {
      if (pointer.rightButtonDown()) {
        this.moveFacingDrag = null;
        this.cancelAim();
        return;
      }
      const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      // Lock the move target at press; drag the mouse to choose facing.
      // Released in onPointerUp → enters reaction phase with chosen facing.
      this.moveFacingDrag = { target: { x: wp.x, y: wp.y }, angle: null };
      this.updateMovePreview(this.moveFacingDrag.target);
      return;
    }
    if (this.aimMode === 'reaction-phase') return;
    if (this.aimMode === 'aim-shoot' || this.aimMode === 'aim-melee') return;
    if (targets.length === 0) this.selectUnit(null);
  }

  private onPointerUp(_pointer: Phaser.Input.Pointer): void {
    if (this.aimMode !== 'aim-move' || !this.moveFacingDrag) return;
    const drag = this.moveFacingDrag;
    this.moveFacingDrag = null;
    const act = this.gameState.initiative.activeActivation;
    if (act) {
      // No drag → default facing = direction of motion (computed when MOVE
      // resolves, since we don't yet know the clipped endpoint here).
      if (drag.angle !== null) {
        this.pendingMoverFacing = { unitId: act.unitId, angle: drag.angle };
      }
    }
    this.enterReactionPhase(drag.target);
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

    // Crawl: cap target distance to 1 unit-distance.
    const isCrawl = this.pendingMoveStance === 'CRAWL';
    let effectiveTarget = target;
    if (isCrawl) {
      const dx = target.x - u.position.x;
      const dy = target.y - u.position.y;
      const len = Math.hypot(dx, dy);
      if (len > UNIT_DISTANCE_PIXELS) {
        effectiveTarget = {
          x: u.position.x + (dx / len) * UNIT_DISTANCE_PIXELS,
          y: u.position.y + (dy / len) * UNIT_DISTANCE_PIXELS,
        };
      }
    }
    const stoppingPolygons = this.gameState.terrain.map((t) => t.polygon);
    const enemyCircles = this.gameState.units
      .filter((o) => o.faction !== u.faction && isUnitAlive(o))
      .map(getUnitCircle);
    const path = computeMovePath(u.position, effectiveTarget, {
      polygons: stoppingPolygons,
      enemyCircles,
      moverRadius: u.radius,
    });
    const enemies = this.gameState.units
      .filter((o) => o.faction !== u.faction && isUnitAlive(o))
      .map((o) => ({
        id: o.id,
        circle: getUnitCircle(o),
        prone: o.stance === 'PRONE',
      }));
    const moverProne = isCrawl || u.stance === 'PRONE';
    const windows = [
      ...computeReactionWindows(
        u.position,
        path.endpoint,
        u.radius,
        enemies,
        this.gameState.terrain,
        { moverProne },
      ),
    ];

    this.reaction = {
      intent: 'MOVE',
      commandType: isCrawl ? 'CRAWL' : 'MOVE',
      moverId: u.id,
      moverStart: { ...u.position },
      moverRadius: u.radius,
      moverFaction: u.faction,
      pathTarget: effectiveTarget,
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

  private enterVaultClimbReactionPhase(commandType: 'VAULT' | 'CLIMB'): void {
    const act = this.gameState.initiative.activeActivation;
    if (!act) return;
    const u = this.gameState.units.find((x) => x.id === act.unitId);
    if (!u) return;
    const wall = this.findContactedHardWallForUnit(u);
    if (!wall) {
      this.hud.pushError(`${u.id} not touching a wall`);
      return;
    }
    const dest =
      commandType === 'VAULT'
        ? vaultDestination(u, wall.polygon.vertices)
        : climbDestination(u, wall.polygon.vertices);

    const enemies = this.gameState.units
      .filter((o) => o.faction !== u.faction && isUnitAlive(o))
      .map((o) => ({
        id: o.id,
        circle: getUnitCircle(o),
        prone: o.stance === 'PRONE',
      }));
    // Reaction windows along the short vault/climb path — only endpoints
    // matter conceptually, but sampling the whole path is simpler.
    const windows = [
      ...computeReactionWindows(
        u.position,
        dest,
        u.radius,
        enemies,
        this.gameState.terrain,
        { moverProne: u.stance === 'PRONE' },
      ),
    ];

    this.reaction = {
      intent: 'MOVE',
      commandType,
      moverId: u.id,
      moverStart: { ...u.position },
      moverRadius: u.radius,
      moverFaction: u.faction,
      pathTarget: dest,
      pathEndpoint: dest,
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
      commandType: 'RALLY',
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
    const mover = this.gameState.units.find(
      (x) => x.id === this.reaction!.moverId,
    );
    return hasLOS(
      getUnitCircle(enemy),
      { center: moverPos, radius: this.reaction.moverRadius },
      this.gameState.terrain,
      {
        aProne: enemy.stance === 'PRONE',
        bProne: mover?.stance === 'PRONE',
      },
    );
  }

  private updateMovePreview(target: Vec2): void {
    this.aimGfx.clear();
    const act = this.gameState.initiative.activeActivation;
    if (!act) return;
    const u = this.gameState.units.find((x) => x.id === act.unitId);
    if (!u) return;

    // For crawl, clamp the visualized target to the 1-unit-distance cap.
    if (this.pendingMoveStance === 'CRAWL') {
      const dx = target.x - u.position.x;
      const dy = target.y - u.position.y;
      const len = Math.hypot(dx, dy);
      if (len > UNIT_DISTANCE_PIXELS) {
        target = {
          x: u.position.x + (dx / len) * UNIT_DISTANCE_PIXELS,
          y: u.position.y + (dy / len) * UNIT_DISTANCE_PIXELS,
        };
      }
    }

    const stoppingPolygons = this.gameState.terrain.map((t) => t.polygon);
    const enemyCircles = this.gameState.units
      .filter((o) => o.faction !== u.faction && isUnitAlive(o))
      .map(getUnitCircle);
    const path = computeMovePath(u.position, target, {
      polygons: stoppingPolygons,
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
      .map((o) => ({
        id: o.id,
        circle: getUnitCircle(o),
        prone: o.stance === 'PRONE',
      }));
    const windows = computeReactionWindows(
      u.position,
      path.endpoint,
      u.radius,
      enemies,
      this.gameState.terrain,
      { moverProne: u.stance === 'PRONE' },
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

    // Facing arrow: visible while pressing+dragging from the endpoint.
    if (this.moveFacingDrag && this.moveFacingDrag.angle !== null) {
      const angle = this.moveFacingDrag.angle;
      const len = u.radius * 2.2;
      const tipX = path.endpoint.x + Math.cos(angle) * len;
      const tipY = path.endpoint.y + Math.sin(angle) * len;
      this.aimGfx.lineStyle(2.5, 0xfff5cf, 0.95);
      this.aimGfx.beginPath();
      this.aimGfx.moveTo(path.endpoint.x, path.endpoint.y);
      this.aimGfx.lineTo(tipX, tipY);
      this.aimGfx.strokePath();
      // Arrowhead.
      const head = 6;
      const ah1x = tipX - Math.cos(angle - Math.PI / 6) * head;
      const ah1y = tipY - Math.sin(angle - Math.PI / 6) * head;
      const ah2x = tipX - Math.cos(angle + Math.PI / 6) * head;
      const ah2y = tipY - Math.sin(angle + Math.PI / 6) * head;
      this.aimGfx.beginPath();
      this.aimGfx.moveTo(tipX, tipY);
      this.aimGfx.lineTo(ah1x, ah1y);
      this.aimGfx.moveTo(tipX, tipY);
      this.aimGfx.lineTo(ah2x, ah2y);
      this.aimGfx.strokePath();
    }
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

export interface SideHealthCount {
  alive: number;
  suppressed: number;
  killed: number;
}

export const countSideHealth = (
  state: GameState,
): { A: SideHealthCount; B: SideHealthCount } => {
  const init = (): SideHealthCount => ({ alive: 0, suppressed: 0, killed: 0 });
  const out = { A: init(), B: init() };
  for (const u of state.units) {
    const side = out[u.faction];
    if (u.damage === 'KILLED') side.killed += 1;
    else {
      side.alive += 1;
      if (u.damage === 'SUPPRESSED') side.suppressed += 1;
    }
  }
  return out;
};

const showBattleHud = (): void => {
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = '';
  const frame = document.getElementById('hud-frame');
  if (frame) (frame as HTMLElement).style.display = '';
};
