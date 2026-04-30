import Phaser from 'phaser';
import { chooseAiCommand } from '../../ai/controller';
import { planReactions } from '../../ai/reaction';
import { applyCommand } from '../../core/commands/reducer';
import { isPointInPolygon } from '../../core/geometry/polygon';
import {
  climbDestination,
  vaultDestination,
} from '../../core/geometry/wallTraversal';
import { drawTerrain, polygonCentroid } from '../rendering/terrain';
import { CombatEffects } from '../rendering/combatEffects';
import { detectScenarioVictory } from '../../core/scenario/victory';
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
import { buildLosBlockers, hasLOS } from '../../core/geometry/los';
import { segmentBlockedByPolygon, segmentBlockedByPolygons } from '../../core/geometry/segment';
import { VAULT_HEIGHT_THRESHOLD_PIXELS } from '../../core/rules/constants';
import { isLowWall } from '../../core/state/GameState';
import { unitHasTrait } from '../../core/traits/types';
import {
  computeReactionWindows,
  type ReactionWindow,
} from '../../core/geometry/los_window';
import { computeMovePath } from '../../core/geometry/path';
import type { Vec2 } from '../../core/geometry/types';
import { v2Dist, v2Lerp } from '../../core/geometry/vec2';
import { formatProfile } from '../../core/resolution/dice';
import { listAvailableShootModes } from '../../core/resolution/shoot_modes';
import { UNIT_DISTANCE_PIXELS } from '../../core/rules/constants';
import type { GameState, Unit } from '../../core/state/GameState';
import {
  getUnitCircle,
  isOnHighGround,
  isUnitAlive,
  movementBlockingPolygons,
  movementExitStopPolygons,
} from '../../core/state/GameState';
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
import { buildMissionState } from '../../missions/buildState';
import { getMissionById } from '../../missions/library';
import {
  advanceAfterMission,
  isRunOver,
  oneShotBoonsFor,
  type MissionResult,
} from '../../runs/state';

const FACTION_COLOR: Readonly<Record<'A' | 'B', number>> = {
  A: 0x4a8acf,
  B: 0xcf5a4a,
};

interface CommandMover {
  unitId: string;
  start: Vec2;
  end: Vec2;
  radius: number;
}

interface ReactionPhaseState {
  intent: 'MOVE' | 'RALLY';
  /** Which command will be dispatched when the reaction phase confirms. */
  commandType: 'MOVE' | 'CRAWL' | 'VAULT' | 'CLIMB' | 'RALLY' | 'COMMAND_MOVE' | 'COMMAND_RALLY';
  moverId: string;
  moverStart: Vec2;
  moverRadius: number;
  moverFaction: 'A' | 'B';
  pathTarget: Vec2;
  pathEndpoint: Vec2;
  windows: ReactionWindow[];
  markers: ReactionMarker[];
  scrubberT: number;
  /** For command actions, all participating movers. Undefined for solo. */
  commandMovers?: CommandMover[];
  /** Currently selected mover for marker targeting. Defaults to moverId for solo. */
  selectedTargetUnitId: string;
  /** For COMMAND_MOVE confirmation, the original cmd payload (without reactionPlan). */
  commandMovePayload?: {
    officerStance?: 'STANDING' | 'CRAWL';
    officerEndProne?: boolean;
    participants: ReadonlyArray<{
      unitId: string;
      target: Vec2;
      stance?: 'STANDING' | 'CRAWL';
      endProne?: boolean;
    }>;
  };
  /** For COMMAND_RALLY confirmation, the participant ids. */
  commandRallyPayload?: { participantIds: ReadonlyArray<string> };
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
  private objectivesGfx!: Phaser.GameObjects.Graphics;
  private objectiveLabels: Phaser.GameObjects.Text[] = [];
  private losOverlayGfx!: Phaser.GameObjects.Graphics;
  /** Unit currently used to source the LOS preview overlay (hover state). */
  private losPreviewUnitId: string | null = null;
  private boardEdgeGfx!: Phaser.GameObjects.Graphics;
  private aimGfx!: Phaser.GameObjects.Graphics;
  private unitLayer!: Phaser.GameObjects.Container;
  private effectsLayer!: Phaser.GameObjects.Container;
  private effects!: CombatEffects;
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
  /** Selected participants while in aim-command-rally. Includes officer if checked. */
  private pendingCommandRally: Set<string> = new Set();
  /** In-flight command-move setup. */
  private pendingCommandMove: {
    officerStance: 'STANDING' | 'CRAWL';
    officerTarget: Vec2 | null;
    participants: Map<
      string,
      { included: boolean; target: Vec2 | null; stance: 'STANDING' | 'CRAWL' }
    >;
  } | null = null;
  /** Which ally we're currently aiming for (in aim-command-move-participant). */
  private cmdMoveAimUnitId: string | null = null;
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
  /** Once user pans/zooms, fitCamera() stops auto-fitting on resize. R resets. */
  private cameraManualOverride = false;
  /** Middle-mouse pan state. */
  private panDrag: { x: number; y: number; scrollX: number; scrollY: number } | null = null;
  /** Roguelite run context — when present, victory routes through Hub / RunResult. */
  private runState: import('../../runs/state').RunState | null = null;
  /** Active mission's win condition. Falls back to elimination for sandbox runs. */
  private missionScenario: import('../../core/scenario/victory').ScenarioMode = 'elimination';
  private missionParams: import('../../core/scenario/victory').ScenarioParams = {};
  /** Initial alive counts captured at mission start — used by engage-reach gating. */
  private missionInitialAlive: { A: number; B: number } = { A: 0, B: 0 };

  constructor() {
    super({ key: 'Battle' });
  }

  init(data: { initialState?: GameState; runState?: import('../../runs/state').RunState }): void {
    // When invoked from the roguelite layer, derive both initialState and
    // runContext from the RunState. When invoked from the legacy 1v1
    // sandbox flow (Roster → Initiative → Deploy), only initialState is
    // present and runContext stays null so victory routes to the standard
    // ResultScene.
    this.runState = data?.runState ?? null;
    this.missionScenario = 'elimination';
    this.missionParams = {};
    if (data?.runState) {
      const idx = data.runState.missionIndex;
      const mid = data.runState.missionIds[idx];
      if (!mid) {
        // Run already past last mission — defensive fallback.
        this.gameState = setupDemoState();
      } else {
        const mission = getMissionById(mid);
        this.missionScenario = mission.scenario;
        this.missionParams = mission.scenarioParams ?? {};
        // Replace BONUS_DICE / NEXT_MISSION_HARDER buffs at spawn-time.
        // One-shot boons are consumed when this mission's state is built.
        const oneShot = oneShotBoonsFor(data.runState);
        this.gameState = buildMissionState(
          mission,
          data.runState,
          `${data.runState.seed}-m${idx}`,
          {
            aliveIds: data.runState.survivorIds,
            damageCarry: data.runState.damageCarry,
            oneShotBoons: oneShot,
            runBoons: data.runState.pickedBoons,
          },
        );
      }
    } else if (data?.initialState) {
      this.gameState = data.initialState;
    } else {
      this.gameState = setupDemoState();
    }
    this.missionInitialAlive = {
      A: this.gameState.units.filter((u) => u.faction === 'A' && isUnitAlive(u)).length,
      B: this.gameState.units.filter((u) => u.faction === 'B' && isUnitAlive(u)).length,
    };
    // Phaser reuses scene instances across scene.start() calls, so all stateful
    // fields must be reset here per match. Field initializers only run once.
    this.selectedUnitId = null;
    this.aimMode = 'idle';
    this.reaction = null;
    this.unitContainers = new Map();
    this.terrainLabels = [];
    this.objectiveLabels = [];
    this.unitFacings = new Map();
    this.moveFacingDrag = null;
    this.pendingMoverFacing = null;
    this.pendingMoveStance = null;
    this.pendingEndProne = false;
    this.pendingCommandRally = new Set();
    this.pendingCommandMove = null;
    this.cmdMoveAimUnitId = null;
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
    this.cameraManualOverride = false;
    this.panDrag = null;
    this.losPreviewUnitId = null;
  }

  create(): void {
    showBattleHud();
    this.replayLog = createReplayLog(this.gameState);
    this.cameras.main.setBackgroundColor('#0a0c0a');

    this.boardEdgeGfx = this.add.graphics();
    this.terrainGfx = this.add.graphics();
    this.objectivesGfx = this.add.graphics();
    // LOS overlay sits between objectives and units so unit circles and
    // their labels remain on top — the overlay is just visual hint
    // material, never selection-blocking.
    this.losOverlayGfx = this.add.graphics();
    this.unitLayer = this.add.container();
    this.effectsLayer = this.add.container();
    this.effects = new CombatEffects(this, this.effectsLayer);
    this.aimGfx = this.add.graphics();

    this.fitCamera();
    const resizeHandler = () => this.fitCamera();
    this.scale.on('resize', resizeHandler);
    this.events.once('shutdown', () => this.scale.off('resize', resizeHandler));

    this.renderTerrain();
    this.renderObjectives();
    this.renderUnits();

    this.input.mouse?.disableContextMenu();
    this.input.on('pointermove', this.onPointerMove, this);
    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.on('pointerup', this.onPointerUp, this);
    this.input.on(
      'wheel',
      (
        pointer: Phaser.Input.Pointer,
        _objs: unknown,
        _dx: number,
        dy: number,
      ) => {
        const factor = dy > 0 ? 0.9 : 1.1;
        // Use the pointer that fired the event (its x/y is freshest).
        // Phaser exposes `event` for the underlying WheelEvent; fall back
        // to pointer.x/y, which is canvas-relative and matches getWorldPoint.
        const evt = (pointer as unknown as { event?: WheelEvent }).event;
        let sx = pointer.x;
        let sy = pointer.y;
        if (evt) {
          const rect = (this.game.canvas as HTMLCanvasElement).getBoundingClientRect();
          sx = evt.clientX - rect.left;
          sy = evt.clientY - rect.top;
        }
        this.zoomCameraAt(sx, sy, factor);
      },
    );
    this.input.keyboard?.on('keydown-ESC', () => {
      // Reaction phase is intentionally not cancellable — handoff is final.
      if (this.aimMode === 'aim-move') this.cancelAim();
      else if (this.aimMode === 'aim-shoot' || this.aimMode === 'aim-melee')
        this.cancelAim();
    });
    this.input.keyboard?.on('keydown-R', () => this.resetCamera());

    this.hud = new Hud(
      (cmd) => this.dispatch(cmd),
      (req) => this.handleActionRequest(req),
      (idx) => this.removeMarker(idx),
      (t) => this.onScrubberChange(t),
      (shooterId, mode, weaponId, parts) =>
        this.tryAddReactionMarker(shooterId, mode, weaponId, parts),
      (faction, enabled) => {
        this.aiControlled[faction] = enabled;
        if (!enabled) this.cancelAiTick();
        this.maybeScheduleAiTick();
      },
      (unitId) => this.toggleCommandRallyParticipant(unitId),
      (unitId) => this.toggleCommandMoveParticipant(unitId),
      (unitId) => this.startCommandMoveParticipantAim(unitId),
      (unitId) => this.selectReactionTarget(unitId),
    );
    // Roguelite mode: force enemy AI on so the player only commands faction A.
    if (this.runState) {
      this.hud.setAi('B', true);
    }
    this.refreshHud();
  }

  /** Approx HUD chrome we want to keep clear of the playfield. */
  private static readonly HUD_RIGHT_PX = 260;
  private static readonly HUD_TOP_PX = 48;
  private static readonly HUD_BOTTOM_PX = 100;

  private fitCamera(): void {
    if (this.cameraManualOverride) {
      this.drawBoardEdge();
      return;
    }
    const cam = this.cameras.main;
    const availW = Math.max(
      200,
      cam.width - BattleScene.HUD_RIGHT_PX,
    );
    const availH = Math.max(
      200,
      cam.height - BattleScene.HUD_TOP_PX - BattleScene.HUD_BOTTOM_PX,
    );
    const margin = 0.94;
    const zoom =
      Math.min(availW / BATTLEFIELD_SIZE_PIXELS, availH / BATTLEFIELD_SIZE_PIXELS) *
      margin;
    cam.setZoom(zoom);
    // Centre the playfield within the visible (non-HUD) rectangle by shifting
    // the camera target up-left to compensate for the right/bottom HUD strips.
    const offsetX = -BattleScene.HUD_RIGHT_PX / 2;
    const offsetY =
      (BattleScene.HUD_TOP_PX - BattleScene.HUD_BOTTOM_PX) / 2;
    cam.centerOn(
      BATTLEFIELD_SIZE_PIXELS / 2 + offsetX / zoom,
      BATTLEFIELD_SIZE_PIXELS / 2 + offsetY / zoom,
    );
    this.drawBoardEdge();
  }

  private resetCamera(): void {
    this.cameraManualOverride = false;
    this.fitCamera();
  }

  private zoomCameraAt(screenX: number, screenY: number, factor: number): void {
    const cam = this.cameras.main;
    const before = cam.getWorldPoint(screenX, screenY);
    const next = Phaser.Math.Clamp(cam.zoom * factor, 0.25, 4);
    cam.setZoom(next);
    const after = cam.getWorldPoint(screenX, screenY);
    cam.scrollX += before.x - after.x;
    cam.scrollY += before.y - after.y;
    this.cameraManualOverride = true;
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

  /**
   * LOS preview overlay — paint a grey rectangle over every map cell that
   * is NOT clearly visible from the hovered unit, with two intensities:
   *   - blocked      → 55% black (high opacity, "you can't see here")
   *   - partial cover → 25% black (low opacity, "smoke / low wall in the
   *                     way; visible but with cover effect")
   *   - full LOS     → no overlay
   *
   * Cells whose centre is inside a HARD wall are skipped — those squares
   * are unreachable and the wall sprite already covers them.
   *
   * Approximation: target is assumed STANDING. Prone-target LOS would
   * differ for low walls, but the preview is a hint, not a rules
   * resolution.
   */
  private renderLosOverlay(unitId: string | null): void {
    this.losOverlayGfx.clear();
    if (!unitId) return;
    const unit = this.gameState.units.find((u) => u.id === unitId);
    if (!unit || !isUnitAlive(unit)) return;

    const cellSize = 24;
    const cols = Math.ceil(BATTLEFIELD_SIZE_PIXELS / cellSize);
    const rows = Math.ceil(BATTLEFIELD_SIZE_PIXELS / cellSize);

    const hardPolys = this.gameState.terrain
      .filter((t) => t.kind === 'HARD')
      .map((t) => t.polygon);
    const lowWallPolys = this.gameState.terrain
      .filter(
        (t) => t.kind === 'HARD' && isLowWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS),
      )
      .map((t) => t.polygon);
    const softPolys = this.gameState.terrain
      .filter((t) => t.kind === 'SOFT')
      .map((t) => t.polygon);

    const losOpts = {
      aProne: unit.stance === 'PRONE',
      bProne: false,
    };

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = (c + 0.5) * cellSize;
        const cy = (r + 0.5) * cellSize;
        const target: Vec2 = { x: cx, y: cy };

        // Skip cells whose centre falls inside a HARD wall — they're
        // unreachable and the wall already paints that area.
        let inHard = false;
        for (const poly of hardPolys) {
          if (isPointInPolygon(target, poly)) {
            inHard = true;
            break;
          }
        }
        if (inHard) continue;

        const blockers = buildLosBlockers(
          unit.position,
          target,
          this.gameState.terrain,
          losOpts,
        );
        const blocked = segmentBlockedByPolygons(
          unit.position,
          target,
          blockers,
        );

        if (blocked) {
          this.losOverlayGfx.fillStyle(0x000000, 0.55);
          this.losOverlayGfx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
          continue;
        }

        // Partial: line clips a cover-providing polygon (soft, or a low
        // wall at standing-vs-standing) OR either endpoint is inside a
        // soft polygon. Cover doesn't block but is informational.
        let partial = false;
        for (const lp of lowWallPolys) {
          if (segmentBlockedByPolygon(unit.position, target, lp)) {
            partial = true;
            break;
          }
        }
        if (!partial) {
          for (const sp of softPolys) {
            if (
              isPointInPolygon(target, sp) ||
              isPointInPolygon(unit.position, sp) ||
              segmentBlockedByPolygon(unit.position, target, sp)
            ) {
              partial = true;
              break;
            }
          }
        }

        if (partial) {
          this.losOverlayGfx.fillStyle(0x000000, 0.25);
          this.losOverlayGfx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
        }
        // Full LOS — leave the cell uncovered.
      }
    }
  }

  /** Hit-test pointer against any alive unit; returns its id or null. */
  private findUnitAtPointer(pointer: Phaser.Input.Pointer): string | null {
    const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    for (const u of this.gameState.units) {
      if (!isUnitAlive(u)) continue;
      const dx = wp.x - u.position.x;
      const dy = wp.y - u.position.y;
      // Slightly enlarge hit radius for forgiveness on hover.
      const r = u.radius + 2;
      if (dx * dx + dy * dy <= r * r) return u.id;
    }
    return null;
  }

  private renderObjectives(): void {
    this.objectivesGfx.clear();
    for (const lbl of this.objectiveLabels) lbl.destroy();
    this.objectiveLabels = [];
    const objs = this.gameState.objectives ?? [];
    // Per-scenario palette so the marker reads at a glance — engage/defend
    // are warm hues (own/keep), extract is green (go!).
    let color = 0xffd166;
    let prefix = '';
    if (this.missionScenario === 'defend') {
      color = 0xff9a3a;
      prefix = '守';
    } else if (this.missionScenario === 'extract') {
      color = 0x6ad08a;
      prefix = '撤';
    }
    for (const o of objs) {
      this.objectivesGfx.fillStyle(color, 0.12);
      this.objectivesGfx.fillCircle(o.position.x, o.position.y, o.radius);
      this.objectivesGfx.lineStyle(2, color, 0.85);
      this.objectivesGfx.strokeCircle(o.position.x, o.position.y, o.radius);
      // Centre cross-hair for legibility
      this.objectivesGfx.lineStyle(1, color, 0.7);
      this.objectivesGfx.beginPath();
      this.objectivesGfx.moveTo(o.position.x - o.radius * 0.3, o.position.y);
      this.objectivesGfx.lineTo(o.position.x + o.radius * 0.3, o.position.y);
      this.objectivesGfx.moveTo(o.position.x, o.position.y - o.radius * 0.3);
      this.objectivesGfx.lineTo(o.position.x, o.position.y + o.radius * 0.3);
      this.objectivesGfx.strokePath();
      const labelText = prefix
        ? `${prefix} ${o.displayName ?? '目標'}`
        : (o.displayName ?? '目標');
      const lbl = this.add.text(
        o.position.x,
        o.position.y + o.radius + 6,
        labelText,
        {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '10px',
          color: `#${color.toString(16).padStart(6, '0')}`,
        },
      );
      lbl.setOrigin(0.5, 0);
      lbl.setAlpha(0.85);
      this.objectiveLabels.push(lbl);
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

    // Facing chevron — Graphics rotates predictably around its own (0,0)
    // origin, so getByName('facing').rotation = angle pivots at unit center.
    // (The previous Container+Triangle wrapper rotated around the triangle's
    // bbox centroid which is offset from (0,0), making rotation appear stuck.)
    const chev = this.add.graphics();
    chev.fillStyle(0xfff5cf, 0.9);
    chev.fillTriangle(
      u.radius * 1.45, 0,
      -u.radius * 0.25, -u.radius * 0.5,
      -u.radius * 0.25, u.radius * 0.5,
    );
    chev.setName('facing');
    container.add(chev);

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
          // Quick-click shortcut: pick the unit's first SOLO/REACTION weapon.
          // Multi-weapon shooters should use the HUD picker for explicit choice.
          const firstReactionWeapon = u.weapons.find(
            (w) => w.kind === 'SHOOT' && w.modes.includes('REACTION'),
          );
          this.tryAddReactionMarker(
            u.id,
            'SOLO',
            firstReactionWeapon?.id,
            [],
          );
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
    chev.rotation = initial;

    return container;
  }

  private setUnitFacing(unitId: string, angle: number): void {
    this.unitFacings.set(unitId, angle);
    const c = this.unitContainers.get(unitId);
    if (!c) return;
    const chev = c.getByName('facing') as Phaser.GameObjects.Graphics | null;
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

    // VIP halo for assassinate scenario — always-visible yellow ring so the
    // player can spot the priority target without selecting it.
    const isVip =
      this.missionScenario === 'assassinate' &&
      this.missionParams.vipUnitId === u.id;
    let vipRing = container.getByName('vip-ring') as
      | Phaser.GameObjects.Graphics
      | null;
    if (isVip) {
      if (!vipRing) {
        vipRing = this.add.graphics();
        vipRing.setName('vip-ring');
        // Add behind arc so the unit's color still reads cleanly through.
        container.addAt(vipRing, 0);
      }
      vipRing.clear();
      vipRing.lineStyle(2.5, 0xffd166, 0.85);
      vipRing.strokeCircle(0, 0, u.radius + 5);
    } else if (vipRing) {
      vipRing.destroy();
    }

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
    const facingChev = container.getByName('facing') as
      | Phaser.GameObjects.Graphics
      | null;
    if (facingChev) facingChev.setAlpha(u.stance === 'PRONE' ? 0.45 : 0.9);

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

    // Damage tag — icon dots under the unit. 1 orange = IMPEDED, 2 red =
    // SUPPRESSED. KILLED units are filtered out before this runs.
    let tag = container.getByName('damage-tag') as
      | Phaser.GameObjects.Graphics
      | null;
    if (u.damage === 'NONE') {
      if (tag) tag.destroy();
    } else {
      if (!tag) {
        tag = this.add.graphics();
        tag.setName('damage-tag');
        container.add(tag);
      }
      tag.clear();
      const y = u.radius + 5.5;
      if (u.damage === 'IMPEDED') {
        tag.fillStyle(0xff9a3a, 1);
        tag.fillCircle(0, y, 2.6);
      } else if (u.damage === 'SUPPRESSED') {
        tag.fillStyle(0xff4444, 1);
        tag.fillCircle(-3.6, y, 2.6);
        tag.fillCircle(3.6, y, 2.6);
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
          const target = this.gameState.units.find(
            (u) => u.id === ev.targetId,
          );
          const shooter = this.gameState.units.find(
            (u) => u.id === ev.shooterId,
          );
          if (target && shooter) {
            this.faceUnitTowardPoint(ev.shooterId, target.position);
            for (const pid of ev.participantIds) {
              this.faceUnitTowardPoint(pid, target.position);
            }
            this.playShotEffects(ev, shooter, target);
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
          if (att && def) this.playMeleeEffects(ev, att, def);
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
   * Victory rules:
   *  - Scenario-aware path via `detectScenarioVictory` covers ELIMINATED,
   *    engage-reach OBJECTIVE_SECURED, defend hold-the-line, and extract
   *    success/failure. Mirrors the sim's runMatch logic so live play and
   *    sim runs reach the same verdict on identical states.
   *  - Sandbox fallback: when no mission scenario is set, all-suppressed
   *    counts as a soft loss and a hard ROUND_LIMIT tiebreak prevents
   *    forever-stalls.
   */
  private checkVictory(): void {
    if (this.victoryFired) return;
    const counts = countSideHealth(this.gameState);
    const v = detectScenarioVictory(
      this.gameState,
      this.missionScenario,
      this.missionParams,
      this.missionInitialAlive,
    );
    let winner: 'A' | 'B' | 'DRAW' | null = null;
    if (v.winner !== null) {
      winner = v.winner;
    } else if (v.reason === 'ELIMINATED') {
      // Mutual wipe — detectScenarioVictory leaves winner=null on both-zero.
      winner = 'DRAW';
    } else if (this.gameState.initiative.round > BattleScene.ROUND_LIMIT) {
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
    // Roguelite run path: route through Hub or RunResult depending on
    // remaining missions / surviving units. Standalone sandbox path keeps
    // routing through ResultScene.
    if (this.runState) {
      const completedMission =
        this.runState.missionIds[this.runState.missionIndex]!;
      const playerUnits = this.gameState.units.filter(
        (u) => u.faction === 'A',
      );
      const survivorIds = playerUnits
        .filter((u) => isUnitAlive(u))
        .map((u) => u.id);
      // isUnitAlive excludes KILLED, so the cast to the carry type is safe.
      const damageCarry: Record<string, 'NONE' | 'IMPEDED' | 'SUPPRESSED'> = {};
      for (const u of playerUnits) {
        if (!isUnitAlive(u)) continue;
        damageCarry[u.id] = u.damage as 'NONE' | 'IMPEDED' | 'SUPPRESSED';
      }
      const losses = playerUnits
        .filter((u) => !isUnitAlive(u))
        .map((u) => u.id);
      const result: MissionResult = {
        missionId: completedMission,
        winner,
        survivorIds,
        losses,
      };
      const advanced = advanceAfterMission(this.runState, result, damageCarry);
      this.time.delayedCall(800, () => {
        if (isRunOver(advanced)) {
          this.scene.start('RunResult', { runState: advanced });
        } else {
          this.scene.start('Hub', { runState: advanced });
        }
      });
      return;
    }
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
          if (!this.reaction) return;
          // Mirror the sim path: ask the defender's reaction planner for
          // markers based on the attacker's path. planReactions only fires
          // for MOVE / CRAWL — other command types get an empty plan, which
          // matches rule 4.4 coverage (VAULT/CLIMB/RALLY/COMMAND_* are
          // reactable per the rules but their path semantics aren't planned
          // in v1; matches the sim's `acceptsReactions` allowlist).
          const ct = this.reaction.commandType;
          const plan =
            ct === 'MOVE' || ct === 'CRAWL'
              ? planReactions(this.gameState, defender, {
                  type: ct,
                  unitId: this.reaction.moverId,
                  target: this.reaction.pathTarget,
                  reactionPlan: { markers: [] },
                })
              : { markers: [] };
          this.reaction.markers = [...plan.markers];
          this.confirmReaction();
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

    // Snappier: ~110 ms per UD instead of 220, with 80 ms floor.
    const duration = Math.max(80, (dist / UNIT_DISTANCE_PIXELS) * 110);
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

  /**
   * Visual chain for a shot: muzzle flash + tracer per firing unit, then
   * (after volley arrival delay) blood mist / hit floater on target, then
   * escalate flash / death marker if damage state advanced. Pure cosmetic.
   */
  private playShotEffects(
    ev: Extract<GameEvent, { type: 'SHOT_RESOLVED' }>,
    shooter: Unit,
    target: Unit,
  ): void {
    const shooters: Unit[] = [shooter];
    for (const pid of ev.participantIds) {
      if (pid === shooter.id) continue;
      const p = this.gameState.units.find((u) => u.id === pid);
      if (p) shooters.push(p);
    }
    let i = 0;
    for (const sh of shooters) {
      const facing = this.unitFacings.get(sh.id) ?? 0;
      const tipOffset = sh.radius * 1.45;
      const stagger = i * 35;
      this.effects.muzzleFlash(sh.position, facing, tipOffset, stagger);
      this.effects.tracer(sh.position, target.position, ev.hits, stagger + 30);
      i += 1;
    }
    const arrivalDelay = (shooters.length - 1) * 35 + 130;
    this.effects.bloodMist(target.position, ev.hits, arrivalDelay);
    if (ev.hits > 0) {
      this.effects.hitFloater(
        target.position,
        `+${ev.hits} HIT${ev.hits > 1 ? 'S' : ''}`,
        '#ff8a6a',
        arrivalDelay,
      );
    } else {
      this.effects.hitFloater(
        target.position,
        'MISS',
        '#aaaaaa',
        arrivalDelay,
      );
    }
    if (ev.afterDamage !== ev.beforeDamage) {
      this.effects.escalateFlash(
        target.position,
        target.radius,
        arrivalDelay + 80,
      );
      if (ev.afterDamage === 'KILLED') {
        this.effects.deathMarker(
          target.position,
          target.radius,
          arrivalDelay + 220,
        );
        this.effects.hitFloater(
          target.position,
          'KILL',
          '#ff3a3a',
          arrivalDelay + 240,
        );
      } else {
        this.effects.hitFloater(
          target.position,
          ev.afterDamage,
          '#ffaa55',
          arrivalDelay + 220,
        );
      }
    }
  }

  /**
   * Visual chain for melee: clash flash at midpoint, hit-count floaters per
   * side, then escalate / death marker on the loser. Melee event lacks an
   * explicit beforeDamage so we approximate using the loser's current state.
   */
  private playMeleeEffects(
    ev: Extract<GameEvent, { type: 'MELEE_RESOLVED' }>,
    attacker: Unit,
    defender: Unit,
  ): void {
    const mid = {
      x: (attacker.position.x + defender.position.x) / 2,
      y: (attacker.position.y + defender.position.y) / 2,
    };
    this.effects.escalateFlash(mid, 9, 0);
    this.effects.hitFloater(
      attacker.position,
      `${ev.attackerHits}h`,
      ev.winnerId === attacker.id ? '#9af09a' : '#aaaaaa',
      40,
    );
    this.effects.hitFloater(
      defender.position,
      `${ev.defenderHits}h`,
      ev.winnerId === defender.id ? '#9af09a' : '#aaaaaa',
      40,
    );
    const loser = ev.loserId === attacker.id ? attacker : defender;
    if (loser.damage !== 'NONE') {
      this.effects.escalateFlash(loser.position, loser.radius, 200);
      this.effects.bloodMist(loser.position, 1, 200);
      if (loser.damage === 'KILLED') {
        this.effects.deathMarker(loser.position, loser.radius, 360);
        this.effects.hitFloater(
          loser.position,
          'KILL',
          '#ff3a3a',
          380,
        );
      } else {
        this.effects.hitFloater(
          loser.position,
          loser.damage,
          '#ffaa55',
          360,
        );
      }
    }
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
      commandRally: this.buildCommandRallyContext(),
      commandMove: this.buildCommandMoveContext(),
    };
    this.hud.update(this.gameState, this.selectedUnitId, this.aimMode, ctx);
    this.hud.setMissionInfo(this.formatMissionLabel());
  }

  /**
   * Build the top-of-HUD scenario tag — shows the win condition + any
   * scenario-specific countdown / count progress so the player can see at
   * a glance what they're racing toward.
   */
  private formatMissionLabel(): string | null {
    const round = this.gameState.initiative.round;
    if (this.missionScenario === 'engage-reach') {
      return '⚑ 攻佔目標';
    }
    if (this.missionScenario === 'defend') {
      const goal = this.missionParams.defendRounds ?? 5;
      return `⚑ 守住目標 ${Math.min(round, goal)}/${goal} 回合`;
    }
    if (this.missionScenario === 'extract') {
      const need = this.missionParams.extractCount ?? 2;
      const limit = this.missionParams.extractRoundLimit ?? 8;
      const onObj = this.gameState.units.filter((u) => {
        if (u.faction !== 'A' || !isUnitAlive(u)) return false;
        const objs = this.gameState.objectives ?? [];
        return objs.some(
          (o) =>
            (u.position.x - o.position.x) ** 2 +
              (u.position.y - o.position.y) ** 2 <=
            o.radius * o.radius,
        );
      }).length;
      return `⚑ 撤離 ${onObj}/${need}・剩 ${Math.max(0, limit - round + 1)} 回合`;
    }
    if (this.missionScenario === 'assassinate') {
      const limit = this.missionParams.assassinateRoundLimit ?? 8;
      const vipId = this.missionParams.vipUnitId;
      const vip = vipId
        ? this.gameState.units.find((u) => u.id === vipId)
        : undefined;
      const status = !vip
        ? '✓'
        : vip.damage === 'KILLED'
          ? '✓'
          : vip.damage === 'NONE'
            ? '⬛'
            : vip.damage; // IMPEDED / SUPPRESSED
      return `⚑ 斬首目標 ${status}・剩 ${Math.max(0, limit - round + 1)} 回合`;
    }
    return null;
  }

  private buildCommandRallyContext():
    | import('../ui/Hud').CommandRallyContext
    | undefined {
    const act = this.gameState.initiative.activeActivation;
    if (!act) return undefined;
    const officer = this.gameState.units.find((u) => u.id === act.unitId);
    if (!officer || !unitHasTrait(officer, 'OFFICER')) return undefined;
    if (!isUnitAlive(officer)) return undefined;
    // Allies within 1 UD (alive, same faction, not officer).
    const nearbyAllies = this.gameState.units.filter(
      (u) =>
        u.id !== officer.id &&
        u.faction === officer.faction &&
        isUnitAlive(u) &&
        v2Dist(u.position, officer.position) <= UNIT_DISTANCE_PIXELS + 0.5,
    );
    const damagedExists =
      officer.damage !== 'NONE' || nearbyAllies.some((a) => a.damage !== 'NONE');
    const canStart = nearbyAllies.length > 0 && damagedExists;
    const candidates: import('../ui/Hud').CommandRallyCandidate[] = [
      {
        id: officer.id,
        note: `(q${officer.quality}+${officer.damage !== 'NONE' ? `, ${officer.damage}` : ''})`,
        isOfficer: true,
        damaged: officer.damage !== 'NONE',
        selected: this.pendingCommandRally.has(officer.id),
      },
      ...nearbyAllies.map((u) => ({
        id: u.id,
        note: `(q${u.quality}+${u.damage !== 'NONE' ? `, ${u.damage}` : ''})`,
        isOfficer: false,
        damaged: u.damage !== 'NONE',
        selected: this.pendingCommandRally.has(u.id),
      })),
    ];
    return {
      officerId: officer.id,
      candidates,
      canStart,
    };
  }

  private selectReactionTarget(unitId: string): void {
    if (!this.reaction) return;
    if (!this.reaction.commandMovers) return;
    if (!this.reaction.commandMovers.some((m) => m.unitId === unitId)) return;
    this.reaction.selectedTargetUnitId = unitId;
    this.drawReactionPreview();
    this.refreshHud();
  }

  private toggleCommandRallyParticipant(unitId: string): void {
    if (this.pendingCommandRally.has(unitId)) {
      this.pendingCommandRally.delete(unitId);
    } else {
      this.pendingCommandRally.add(unitId);
    }
    this.refreshHud();
  }

  private buildCommandMoveContext():
    | import('../ui/Hud').CommandMoveContext
    | undefined {
    const act = this.gameState.initiative.activeActivation;
    if (!act) return undefined;
    const officer = this.gameState.units.find((u) => u.id === act.unitId);
    if (!officer || !unitHasTrait(officer, 'OFFICER')) return undefined;
    if (!isUnitAlive(officer)) return undefined;
    if (officer.damage !== 'NONE') return undefined;
    const nearby = this.gameState.units.filter(
      (u) =>
        u.id !== officer.id &&
        u.faction === officer.faction &&
        isUnitAlive(u) &&
        u.damage === 'NONE' &&
        v2Dist(u.position, officer.position) <= UNIT_DISTANCE_PIXELS + 0.5,
    );
    const canStart = nearby.length > 0;
    const pcm = this.pendingCommandMove;
    const officerTarget = pcm?.officerTarget ?? undefined;
    const officerStance = pcm?.officerStance;
    const participants: import('../ui/Hud').CommandMoveParticipant[] = nearby.map(
      (u) => {
        const slot = pcm?.participants.get(u.id);
        const target = slot?.target ?? null;
        const targetValid =
          !!target &&
          !!officerTarget &&
          v2Dist(target, officerTarget) <= UNIT_DISTANCE_PIXELS + 0.5;
        return {
          unitId: u.id,
          note: `(q${u.quality}+)`,
          included: slot?.included ?? false,
          target: target ? { x: target.x, y: target.y } : null,
          targetValid,
          stance: slot?.stance ?? 'STANDING',
        };
      },
    );
    return {
      officerId: officer.id,
      canStart,
      officerTarget: officerTarget
        ? { x: officerTarget.x, y: officerTarget.y }
        : undefined,
      officerStance,
      participants,
    };
  }

  private toggleCommandMoveParticipant(unitId: string): void {
    if (!this.pendingCommandMove) return;
    const slot = this.pendingCommandMove.participants.get(unitId) ?? {
      included: false,
      target: null,
      stance: 'STANDING' as const,
    };
    const next = { ...slot, included: !slot.included };
    this.pendingCommandMove.participants.set(unitId, next);
    this.refreshHud();
    this.drawCommandMoveOverlay();
  }

  private startCommandMoveParticipantAim(unitId: string): void {
    if (!this.pendingCommandMove) return;
    if (!this.pendingCommandMove.officerTarget) return;
    this.cmdMoveAimUnitId = unitId;
    this.aimMode = 'aim-command-move-participant';
    // Make sure the participant is included.
    const slot = this.pendingCommandMove.participants.get(unitId) ?? {
      included: true,
      target: null,
      stance: 'STANDING' as const,
    };
    this.pendingCommandMove.participants.set(unitId, {
      ...slot,
      included: true,
    });
    this.refreshHud();
    this.drawCommandMoveOverlay();
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
          r.selectedTargetUnitId,
          'REACTION',
          committed,
        );
        return {
          id: shooter.id,
          note: `(q${shooter.quality}+${shooter.damage !== 'NONE' ? `, ${shooter.damage}` : ''})`,
          modes: modes.map((m) => ({
            mode: m.mode,
            weaponId: m.weaponId,
            weaponDisplay: m.weaponDisplay,
            participantIds: m.participantIds,
            totalDice: m.totalDice,
            diceReadout: formatProfile(m.profile),
          })),
        };
      })
      .filter((r) => r.modes.length > 0);
    const commandMovers = r.commandMovers
      ? r.commandMovers.map((m) => ({
          unitId: m.unitId,
          selected: m.unitId === r.selectedTargetUnitId,
        }))
      : undefined;
    return {
      defenderFaction: r.moverFaction === 'A' ? 'B' : 'A',
      intent: r.intent,
      markers: r.markers,
      currentT: r.scrubberT,
      visibleReactors: reactors,
      commandMovers,
      windows: r.windows.map((w) => ({ startT: w.startT, endT: w.endT })),
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
    // For command actions, position the *selected target* at scrubber t along
    // its own path. Solo actions: same as before (only mover).
    const targetId = r.selectedTargetUnitId;
    let start = r.moverStart;
    let end = r.pathEndpoint;
    if (r.commandMovers) {
      const cm = r.commandMovers.find((m) => m.unitId === targetId);
      if (cm) {
        start = cm.start;
        end = cm.end;
      }
    }
    const moverPos = v2Lerp(start, end, r.scrubberT);
    return {
      ...this.gameState,
      units: this.gameState.units.map((u) =>
        u.id === targetId ? { ...u, position: moverPos } : u,
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
            weaponId: m.weaponId,
            weaponDisplay: m.weaponDisplay,
            participantIds: m.participantIds,
            totalDice: m.totalDice,
            diceReadout: formatProfile(m.profile),
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
      case 'REQUEST_COMMAND_RALLY': {
        const act = this.gameState.initiative.activeActivation;
        if (!act) return;
        const officer = this.gameState.units.find((u) => u.id === act.unitId);
        if (!officer || !unitHasTrait(officer, 'OFFICER')) return;
        // Auto-select all damaged units within 1 UD by default.
        this.pendingCommandRally = new Set();
        if (officer.damage !== 'NONE')
          this.pendingCommandRally.add(officer.id);
        for (const u of this.gameState.units) {
          if (
            u.id !== officer.id &&
            u.faction === officer.faction &&
            isUnitAlive(u) &&
            u.damage !== 'NONE' &&
            v2Dist(u.position, officer.position) <=
              UNIT_DISTANCE_PIXELS + 0.5
          ) {
            this.pendingCommandRally.add(u.id);
          }
        }
        this.aimMode = 'aim-command-rally';
        this.refreshHud();
        return;
      }
      case 'REQUEST_COMMAND_MOVE': {
        const act = this.gameState.initiative.activeActivation;
        if (!act) return;
        const officer = this.gameState.units.find((u) => u.id === act.unitId);
        if (!officer || !unitHasTrait(officer, 'OFFICER')) return;
        if (officer.damage !== 'NONE') return;
        this.pendingCommandMove = {
          officerStance: 'STANDING',
          officerTarget: null,
          participants: new Map(),
        };
        this.aimMode = 'aim-command-move-officer-stance';
        this.refreshHud();
        return;
      }
      case 'CHOOSE_CMD_MOVE_STANDING': {
        if (!this.pendingCommandMove) return;
        this.pendingCommandMove.officerStance = 'STANDING';
        this.aimMode = 'aim-command-move-officer';
        this.refreshHud();
        return;
      }
      case 'CHOOSE_CMD_MOVE_CRAWL': {
        if (!this.pendingCommandMove) return;
        this.pendingCommandMove.officerStance = 'CRAWL';
        this.aimMode = 'aim-command-move-officer';
        this.refreshHud();
        return;
      }
      case 'BACK_TO_CMD_MOVE_SETUP': {
        if (!this.pendingCommandMove) return;
        this.cmdMoveAimUnitId = null;
        this.aimMode = 'aim-command-move-setup';
        this.refreshHud();
        this.drawCommandMoveOverlay();
        return;
      }
      case 'CONFIRM_COMMAND_MOVE': {
        const act = this.gameState.initiative.activeActivation;
        if (!act || !this.pendingCommandMove) return;
        const pcm = this.pendingCommandMove;
        if (!pcm.officerTarget) {
          this.hud.pushError('Officer target not set');
          return;
        }
        const participants: Array<{
          unitId: string;
          target: Vec2;
          stance: 'STANDING' | 'CRAWL';
        }> = [];
        for (const [id, slot] of pcm.participants) {
          if (!slot.included) continue;
          if (!slot.target) {
            this.hud.pushError(`${id} has no target`);
            return;
          }
          participants.push({ unitId: id, target: slot.target, stance: slot.stance });
        }
        if (participants.length === 0) {
          this.hud.pushError('Pick at least one ally');
          return;
        }
        // Enter group reaction phase. The actual dispatch happens after
        // confirmReaction.
        this.enterCommandMoveReactionPhase(
          act.unitId,
          pcm.officerStance,
          pcm.officerTarget,
          participants,
        );
        return;
      }
      case 'CONFIRM_COMMAND_RALLY': {
        const act = this.gameState.initiative.activeActivation;
        if (!act) return;
        const officerId = act.unitId;
        const allyIds = Array.from(this.pendingCommandRally).filter(
          (id) => id !== officerId,
        );
        if (allyIds.length === 0) {
          this.hud.pushError('Command Rally requires at least one ally');
          return;
        }
        // Enter group reaction phase. Actual dispatch happens after confirm.
        this.enterCommandRallyReactionPhase(officerId, allyIds);
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
    this.pendingCommandRally = new Set();
    this.pendingCommandMove = null;
    this.cmdMoveAimUnitId = null;
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
    this.pendingCommandMove = null;
    this.cmdMoveAimUnitId = null;
    this.pendingCommandRally = new Set();
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
      case 'COMMAND_MOVE':
        if (r.commandMovePayload) {
          this.dispatch({
            type: 'COMMAND_MOVE',
            officerId: r.moverId,
            officerTarget: r.pathTarget,
            officerStance: r.commandMovePayload.officerStance,
            officerEndProne: r.commandMovePayload.officerEndProne,
            participants: r.commandMovePayload.participants,
            reactionPlan: plan,
          });
        }
        break;
      case 'COMMAND_RALLY':
        if (r.commandRallyPayload) {
          this.dispatch({
            type: 'COMMAND_RALLY',
            officerId: r.moverId,
            participantIds: r.commandRallyPayload.participantIds,
            reactionPlan: plan,
          });
        }
        break;
    }
    void stanceUsed;
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.panDrag) {
      const cam = this.cameras.main;
      cam.scrollX = this.panDrag.scrollX + (this.panDrag.x - pointer.x) / cam.zoom;
      cam.scrollY = this.panDrag.scrollY + (this.panDrag.y - pointer.y) / cam.zoom;
      return;
    }
    // LOS preview overlay: only when idle (not aiming / not in reaction
    // phase). Showing during aim modes would add visual noise on top of
    // the aim cursor + move-preview lines.
    if (this.aimMode === 'idle') {
      const hovered = this.findUnitAtPointer(pointer);
      if (hovered !== this.losPreviewUnitId) {
        this.losPreviewUnitId = hovered;
        this.renderLosOverlay(hovered);
      }
    } else if (this.losPreviewUnitId !== null) {
      this.losPreviewUnitId = null;
      this.renderLosOverlay(null);
    }
    if (this.aimMode === 'aim-command-move-officer') {
      const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.updateMovePreview({ x: wp.x, y: wp.y });
      return;
    }
    if (this.aimMode === 'aim-command-move-participant') {
      this.drawCommandMoveOverlay();
      const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.drawCommandMoveCursorPreview({ x: wp.x, y: wp.y });
      return;
    }
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
    // Middle-mouse: start a camera pan, swallowing the click.
    if (pointer.middleButtonDown()) {
      const cam = this.cameras.main;
      this.panDrag = {
        x: pointer.x,
        y: pointer.y,
        scrollX: cam.scrollX,
        scrollY: cam.scrollY,
      };
      this.cameraManualOverride = true;
      return;
    }
    if (this.aimMode === 'aim-command-move-officer') {
      if (pointer.rightButtonDown()) {
        this.cancelAim();
        return;
      }
      const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      if (!this.pendingCommandMove) return;
      this.pendingCommandMove.officerTarget = { x: wp.x, y: wp.y };
      this.aimMode = 'aim-command-move-setup';
      this.refreshHud();
      this.drawCommandMoveOverlay();
      return;
    }
    if (this.aimMode === 'aim-command-move-participant') {
      if (pointer.rightButtonDown()) {
        this.cmdMoveAimUnitId = null;
        this.aimMode = 'aim-command-move-setup';
        this.refreshHud();
        this.drawCommandMoveOverlay();
        return;
      }
      if (!this.pendingCommandMove || !this.cmdMoveAimUnitId) return;
      if (!this.pendingCommandMove.officerTarget) return;
      const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      const officerTarget = this.pendingCommandMove.officerTarget;
      // Reject clicks > 1 UD from officer target.
      if (
        v2Dist({ x: wp.x, y: wp.y }, officerTarget) >
        UNIT_DISTANCE_PIXELS + 0.5
      ) {
        this.hud.pushError('Outside the 1 unit-distance ring');
        return;
      }
      const slot = this.pendingCommandMove.participants.get(
        this.cmdMoveAimUnitId,
      ) ?? { included: true, target: null, stance: 'STANDING' as const };
      this.pendingCommandMove.participants.set(this.cmdMoveAimUnitId, {
        ...slot,
        included: true,
        target: { x: wp.x, y: wp.y },
      });
      this.cmdMoveAimUnitId = null;
      this.aimMode = 'aim-command-move-setup';
      this.refreshHud();
      this.drawCommandMoveOverlay();
      return;
    }
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
    if (this.panDrag) {
      this.panDrag = null;
      return;
    }
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
    const stoppingPolygons = movementBlockingPolygons(this.gameState.terrain, u.position);
    const enterStopPolygons = this.gameState.terrain
      .filter((t) => t.kind === 'DIFFICULT')
      .map((t) => t.polygon);
    const exitStopPolygons = movementExitStopPolygons(this.gameState.terrain, u.position);
    const enemyCircles = this.gameState.units
      .filter((o) => o.faction !== u.faction && isUnitAlive(o))
      .map(getUnitCircle);
    const friendlyCircles = this.gameState.units
      .filter(
        (o) => o.faction === u.faction && o.id !== u.id && isUnitAlive(o),
      )
      .map(getUnitCircle);
    const path = computeMovePath(u.position, effectiveTarget, {
      polygons: stoppingPolygons,
      enterStopPolygons,
      exitStopPolygons,
      enemyCircles,
      friendlyCircles,
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
      selectedTargetUnitId: u.id,
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
      selectedTargetUnitId: u.id,
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

  /**
   * Set up a multi-mover reaction phase for COMMAND_MOVE. Each participant
   * (officer + selected allies) has its own path; the defender targets one
   * of them per marker. Resolved by the reducer's group reaction handler;
   * if any marker hits & suppresses/kills, the entire group stops at that t.
   */
  private enterCommandMoveReactionPhase(
    officerId: string,
    officerStance: 'STANDING' | 'CRAWL',
    officerTarget: Vec2,
    participants: ReadonlyArray<{
      unitId: string;
      target: Vec2;
      stance: 'STANDING' | 'CRAWL';
    }>,
  ): void {
    const officer = this.gameState.units.find((u) => u.id === officerId);
    if (!officer) return;

    // Compute paths for officer + each participant (caps for crawl, edge stops).
    // stoppingPolygons differs per mover because HIGH_GROUND only blocks
    // movers starting outside the platform — see reducer mirror logic.
    const enterStopPolygons = this.gameState.terrain
      .filter((t) => t.kind === 'DIFFICULT')
      .map((t) => t.polygon);
    const moverIds = new Set<string>([officerId, ...participants.map((p) => p.unitId)]);
    const buildPath = (
      moverId: string,
      from: Vec2,
      target: Vec2,
      stance: 'STANDING' | 'CRAWL',
      moverFaction: 'A' | 'B',
      moverRadius: number,
    ): Vec2 => {
      let effective = target;
      if (stance === 'CRAWL') {
        const dx = target.x - from.x;
        const dy = target.y - from.y;
        const len = Math.hypot(dx, dy);
        if (len > UNIT_DISTANCE_PIXELS) {
          effective = {
            x: from.x + (dx / len) * UNIT_DISTANCE_PIXELS,
            y: from.y + (dy / len) * UNIT_DISTANCE_PIXELS,
          };
        }
      }
      const enemyCircles = this.gameState.units
        .filter((o) => o.faction !== moverFaction && isUnitAlive(o))
        .map(getUnitCircle);
      // Friendlies = same-faction non-participant alive units (exclude self
      // and other movers). Match reducer's command-move logic.
      const friendlyCircles = this.gameState.units
        .filter(
          (o) =>
            o.faction === moverFaction &&
            !moverIds.has(o.id) &&
            o.id !== moverId &&
            isUnitAlive(o),
        )
        .map(getUnitCircle);
      const stoppingPolygons = movementBlockingPolygons(this.gameState.terrain, from);
      const exitStopPolygons = movementExitStopPolygons(this.gameState.terrain, from);
      const path = computeMovePath(from, effective, {
        polygons: stoppingPolygons,
        enterStopPolygons,
        exitStopPolygons,
        enemyCircles,
        friendlyCircles,
        moverRadius,
      });
      return path.endpoint;
    };

    const officerEnd = buildPath(
      officer.id,
      officer.position,
      officerTarget,
      officerStance,
      officer.faction,
      officer.radius,
    );
    const movers: CommandMover[] = [
      {
        unitId: officer.id,
        start: { ...officer.position },
        end: officerEnd,
        radius: officer.radius,
      },
    ];
    for (const p of participants) {
      const u = this.gameState.units.find((x) => x.id === p.unitId);
      if (!u) continue;
      const end = buildPath(
        u.id,
        u.position,
        p.target,
        p.stance,
        u.faction,
        u.radius,
      );
      movers.push({
        unitId: u.id,
        start: { ...u.position },
        end,
        radius: u.radius,
      });
    }

    // Reaction windows for the officer's path (used by the existing scrubber
    // visualization). The new target switcher will refine LOS per selected
    // target on demand.
    const enemiesForLOS = this.gameState.units
      .filter((o) => o.faction !== officer.faction && isUnitAlive(o))
      .map((o) => ({
        id: o.id,
        circle: getUnitCircle(o),
        prone: o.stance === 'PRONE',
      }));
    const windows = [
      ...computeReactionWindows(
        officer.position,
        officerEnd,
        officer.radius,
        enemiesForLOS,
        this.gameState.terrain,
        { moverProne: officerStance === 'CRAWL' || officer.stance === 'PRONE' },
      ),
    ];

    this.reaction = {
      intent: 'MOVE',
      commandType: 'COMMAND_MOVE',
      moverId: officer.id,
      moverStart: { ...officer.position },
      moverRadius: officer.radius,
      moverFaction: officer.faction,
      pathTarget: officerTarget,
      pathEndpoint: officerEnd,
      windows,
      markers: [],
      scrubberT: 0,
      selectedTargetUnitId: officer.id,
      commandMovers: movers,
      commandMovePayload: {
        officerStance,
        officerEndProne: false,
        participants,
      },
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

  /**
   * Set up a multi-rallier reaction phase for COMMAND_RALLY. Stationary
   * paths per rallier; defender picks one as target per marker.
   */
  private enterCommandRallyReactionPhase(
    officerId: string,
    participantIds: ReadonlyArray<string>,
  ): void {
    const officer = this.gameState.units.find((u) => u.id === officerId);
    if (!officer) return;
    const movers: CommandMover[] = [
      {
        unitId: officer.id,
        start: { ...officer.position },
        end: { ...officer.position },
        radius: officer.radius,
      },
    ];
    for (const pid of participantIds) {
      const u = this.gameState.units.find((x) => x.id === pid);
      if (!u) continue;
      movers.push({
        unitId: u.id,
        start: { ...u.position },
        end: { ...u.position },
        radius: u.radius,
      });
    }
    this.reaction = {
      intent: 'RALLY',
      commandType: 'COMMAND_RALLY',
      moverId: officer.id,
      moverStart: { ...officer.position },
      moverRadius: officer.radius,
      moverFaction: officer.faction,
      pathTarget: { ...officer.position },
      pathEndpoint: { ...officer.position },
      windows: [],
      markers: [],
      scrubberT: 0,
      selectedTargetUnitId: officer.id,
      commandMovers: movers,
      commandRallyPayload: { participantIds },
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
      selectedTargetUnitId: u.id,
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
    weaponId?: string,
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
      targetUnitId: this.reaction.selectedTargetUnitId,
      ...(weaponId !== undefined ? { weaponId } : {}),
    };
    this.reaction.markers = [...this.reaction.markers, marker].sort(
      (a, b) => a.atT - b.atT,
    );
    this.drawReactionPreview();
    this.refreshHud();
  }

  private enemyVisibleAtCurrentScrubber(enemy: Unit): boolean {
    if (!this.reaction) return false;
    // For command actions, LOS is checked against the *currently selected*
    // target mover, not the activating officer. Path lookup goes through
    // commandMovers when present.
    const targetId = this.reaction.selectedTargetUnitId;
    let start = this.reaction.moverStart;
    let end = this.reaction.pathEndpoint;
    let radius = this.reaction.moverRadius;
    if (this.reaction.commandMovers) {
      const cm = this.reaction.commandMovers.find((m) => m.unitId === targetId);
      if (cm) {
        start = cm.start;
        end = cm.end;
        radius = cm.radius;
      }
    }
    const targetPos = v2Lerp(start, end, this.reaction.scrubberT);
    const targetUnit = this.gameState.units.find((x) => x.id === targetId);
    return hasLOS(
      getUnitCircle(enemy),
      { center: targetPos, radius },
      this.gameState.terrain,
      {
        aProne: enemy.stance === 'PRONE',
        bProne: targetUnit?.stance === 'PRONE',
        aOnHighGround: isOnHighGround(enemy, this.gameState.terrain),
        bOnHighGround: targetUnit
          ? isOnHighGround(targetUnit, this.gameState.terrain)
          : false,
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

    const stoppingPolygons = this.gameState.terrain
      .filter((t) => t.kind === 'HARD')
      .map((t) => t.polygon);
    const enterStopPolygons = this.gameState.terrain
      .filter((t) => t.kind === 'DIFFICULT')
      .map((t) => t.polygon);
    const enemyCircles = this.gameState.units
      .filter((o) => o.faction !== u.faction && isUnitAlive(o))
      .map(getUnitCircle);
    const friendlyCircles = this.gameState.units
      .filter(
        (o) => o.faction === u.faction && o.id !== u.id && isUnitAlive(o),
      )
      .map(getUnitCircle);
    const path = computeMovePath(u.position, target, {
      polygons: stoppingPolygons,
      enterStopPolygons,
      enemyCircles,
      friendlyCircles,
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

    // Reaction-threat preview: only enemies that COULD actually react are
    // surfaced as red. SUPPRESSED, already-used-reaction, and weaponless
    // enemies fall out — those windows would be cosmetic noise.
    const reactionCapable = (o: Unit): boolean =>
      isUnitAlive(o) &&
      o.faction !== u.faction &&
      o.damage !== 'SUPPRESSED' &&
      !o.cannotReactThisRound &&
      o.weapons.some(
        (w) => w.kind === 'SHOOT' && w.modes.includes('REACTION'),
      );
    const threats = this.gameState.units.filter(reactionCapable);
    const enemies = threats.map((o) => ({
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
    this.aimGfx.lineStyle(4, 0xff5555, 0.75);
    for (const w of windows) {
      const startP = v2Lerp(u.position, path.endpoint, w.startT);
      const endP = v2Lerp(u.position, path.endpoint, w.endT);
      this.aimGfx.beginPath();
      this.aimGfx.moveTo(startP.x, startP.y);
      this.aimGfx.lineTo(endP.x, endP.y);
      this.aimGfx.strokePath();
    }
    // Warning ring around each reactor that has at least one window.
    const reactingIds = new Set(windows.map((w) => w.enemyUnitId));
    this.aimGfx.lineStyle(2, 0xff5555, 0.85);
    for (const t of threats) {
      if (!reactingIds.has(t.id)) continue;
      this.aimGfx.strokeCircle(t.position.x, t.position.y, t.radius + 4);
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

  private drawCommandMoveOverlay(): void {
    this.aimGfx.clear();
    if (!this.pendingCommandMove) return;
    const pcm = this.pendingCommandMove;
    if (!pcm.officerTarget) return;
    const act = this.gameState.initiative.activeActivation;
    if (!act) return;
    const officer = this.gameState.units.find((u) => u.id === act.unitId);
    if (!officer) return;

    // Officer's path
    this.aimGfx.lineStyle(1.5, FACTION_COLOR[officer.faction], 0.9);
    this.aimGfx.beginPath();
    this.aimGfx.moveTo(officer.position.x, officer.position.y);
    this.aimGfx.lineTo(pcm.officerTarget.x, pcm.officerTarget.y);
    this.aimGfx.strokePath();
    this.aimGfx.fillStyle(FACTION_COLOR[officer.faction], 0.35);
    this.aimGfx.fillCircle(
      pcm.officerTarget.x,
      pcm.officerTarget.y,
      officer.radius,
    );

    // Validity ring around officer's target (1 UD).
    this.aimGfx.lineStyle(1.5, 0x9af09a, 0.85);
    this.aimGfx.strokeCircle(
      pcm.officerTarget.x,
      pcm.officerTarget.y,
      UNIT_DISTANCE_PIXELS,
    );

    // Each participant's planned target (if any).
    for (const [id, slot] of pcm.participants) {
      const u = this.gameState.units.find((x) => x.id === id);
      if (!u || !slot.target) continue;
      const valid = v2Dist(slot.target, pcm.officerTarget) <= UNIT_DISTANCE_PIXELS + 0.5;
      const color = valid ? FACTION_COLOR[u.faction] : 0xff5555;
      this.aimGfx.lineStyle(1.5, color, slot.included ? 0.85 : 0.35);
      this.aimGfx.beginPath();
      this.aimGfx.moveTo(u.position.x, u.position.y);
      this.aimGfx.lineTo(slot.target.x, slot.target.y);
      this.aimGfx.strokePath();
      this.aimGfx.fillStyle(color, slot.included ? 0.35 : 0.15);
      this.aimGfx.fillCircle(slot.target.x, slot.target.y, u.radius);
    }
  }

  private drawCommandMoveCursorPreview(cursor: Vec2): void {
    if (!this.pendingCommandMove) return;
    const pcm = this.pendingCommandMove;
    if (!pcm.officerTarget || !this.cmdMoveAimUnitId) return;
    const u = this.gameState.units.find((x) => x.id === this.cmdMoveAimUnitId);
    if (!u) return;
    const valid =
      v2Dist(cursor, pcm.officerTarget) <= UNIT_DISTANCE_PIXELS + 0.5;
    const color = valid ? 0x9af09a : 0xff5555;
    this.aimGfx.lineStyle(2, color, 0.95);
    this.aimGfx.fillStyle(color, 0.25);
    this.aimGfx.fillCircle(cursor.x, cursor.y, u.radius);
    this.aimGfx.strokeCircle(cursor.x, cursor.y, u.radius);
    this.aimGfx.beginPath();
    this.aimGfx.moveTo(u.position.x, u.position.y);
    this.aimGfx.lineTo(cursor.x, cursor.y);
    this.aimGfx.strokePath();
  }

  private drawReactionPreview(): void {
    this.aimGfx.clear();
    if (!this.reaction) return;
    const r = this.reaction;
    const moverColor = FACTION_COLOR[r.moverFaction];

    // Multi-mover (command actions): draw each mover's path + ghost. Highlight
    // the currently selected target.
    if (r.commandMovers && r.commandMovers.length > 1) {
      for (const cm of r.commandMovers) {
        const isSelected = cm.unitId === r.selectedTargetUnitId;
        const lineAlpha = isSelected ? 0.95 : 0.45;
        const strokeAlpha = isSelected ? 0.95 : 0.4;
        // Path tube.
        this.aimGfx.lineStyle(cm.radius * 2, moverColor, 0.1);
        this.aimGfx.beginPath();
        this.aimGfx.moveTo(cm.start.x, cm.start.y);
        this.aimGfx.lineTo(cm.end.x, cm.end.y);
        this.aimGfx.strokePath();
        // Path centerline.
        this.aimGfx.lineStyle(1.5, 0xcfe8cf, lineAlpha);
        this.aimGfx.beginPath();
        this.aimGfx.moveTo(cm.start.x, cm.start.y);
        this.aimGfx.lineTo(cm.end.x, cm.end.y);
        this.aimGfx.strokePath();
        // Endpoint ring.
        this.aimGfx.lineStyle(1.5, moverColor, strokeAlpha);
        this.aimGfx.strokeCircle(cm.end.x, cm.end.y, cm.radius);
        // Ghost at scrubber t (only for selected, others get stationary mid).
        if (isSelected) {
          const ghost = v2Lerp(cm.start, cm.end, r.scrubberT);
          this.aimGfx.fillStyle(moverColor, 0.55);
          this.aimGfx.fillCircle(ghost.x, ghost.y, cm.radius);
          this.aimGfx.lineStyle(2, 0xffd166, 0.95);
          this.aimGfx.strokeCircle(ghost.x, ghost.y, cm.radius + 2);
        } else {
          const ghost = v2Lerp(cm.start, cm.end, r.scrubberT);
          this.aimGfx.fillStyle(moverColor, 0.3);
          this.aimGfx.fillCircle(ghost.x, ghost.y, cm.radius);
        }
      }
      // Markers: draw each at their target's path-position, color-coded by target.
      for (const m of r.markers) {
        const targetId = m.targetUnitId ?? r.moverId;
        const cm = r.commandMovers.find((x) => x.unitId === targetId);
        if (!cm) continue;
        const p = v2Lerp(cm.start, cm.end, m.atT);
        this.aimGfx.fillStyle(0xffd166, 1);
        this.aimGfx.fillCircle(p.x, p.y, 5);
        this.aimGfx.lineStyle(1, 0x000000, 1);
        this.aimGfx.strokeCircle(p.x, p.y, 5);
      }
      return;
    }

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
