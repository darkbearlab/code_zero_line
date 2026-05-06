import Phaser from 'phaser';
import { chooseAiCommand } from '../../ai/controller';
import { planReactions } from '../../ai/reaction';
import { applyCommand } from '../../core/commands/reducer';
import { isPointInPolygon } from '../../core/geometry/polygon';
import {
  climbDestination,
  findContactedDoor,
  findContactedSoftTerrain,
  findContactedWall,
  traverseDestination,
  vaultDestination,
} from '../../core/geometry/wallTraversal';
import { drawTerrain } from '../rendering/terrain';
import { paintBoardFloorPhaser } from '../rendering/boardFloor';
import { CombatEffects } from '../rendering/combatEffects';
import { computeVisibilityPolygon } from '../rendering/visibilityPolygon';
import { detectScenarioVictory } from '../../core/scenario/victory';
import { formatScenarioProgress } from '../../core/scenario/progress';
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
  TurnoverReason,
} from '../../core/commands/types';
import { CommandError } from '../../core/commands/types';
import { hasLOS } from '../../core/geometry/los';
import { effectiveLOS } from '../../core/geometry/effective-los';
import { coverDetail } from '../../core/resolution/cover';
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
  movementEnterStopPolygons,
  movementExitStopPolygons,
} from '../../core/state/GameState';
import timersConfig from '../../config/timers.json';
import {
  listUnitTemplates,
  resolveFactionColorForTags,
  tagsOf,
} from '../../config/loader';
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
  currentMissionStealthActive,
  currentMissionNoIntelActive,
  isRunOver,
  oneShotBoonsFor,
  type MissionResult,
} from '../../runs/state';

const FACTION_COLOR: Readonly<Record<'A' | 'B', number>> = {
  A: 0x4a8acf,
  B: 0xcf5a4a,
};

/**
 * Fill a simple polygon ring into mask Graphics `g` at white alpha 1. Used
 * for LOS overlay masks: the visible layer is masked by these polygons with
 * invertAlpha, so only the alpha (not the colour) of the mask matters.
 */
const drawPolygonPath = (
  g: Phaser.GameObjects.Graphics,
  verts: ReadonlyArray<Vec2>,
): void => {
  if (verts.length < 3) return;
  g.fillStyle(0xffffff, 1);
  g.beginPath();
  g.moveTo(verts[0]!.x, verts[0]!.y);
  for (let i = 1; i < verts.length; i++) {
    g.lineTo(verts[i]!.x, verts[i]!.y);
  }
  g.closePath();
  g.fillPath();
};

// Translucent overlay alpha for faction tint on sprites. ~0.4 reads clearly
// on white/light areas of the sprite while keeping the sprite's own
// shading/detail visible (avoiding the crushing effect of multiplicative tint).
const TINT_OVERLAY_ALPHA = 0.4;

// Movement tween pacing — tweak these to adjust how snappy unit motion
// feels. Total duration = max(MOVEMENT_TWEEN_MIN_MS, distInUD * MS_PER_UD).
// Lower MS_PER_UD = faster slide; lower MIN_MS = shorter floor for tiny
// nudges. Used by animateMove for every MOVE_RESOLVED event.
const MOVEMENT_MS_PER_UD = 220;
const MOVEMENT_TWEEN_MIN_MS = 160;
// Crawl flip cadence (ms between left/right mirror toggles on the prone
// sprite during a tween). Lower = faster limb activity.
const CRAWL_FLIP_INTERVAL_MS = 200;

interface CommandMover {
  unitId: string;
  start: Vec2;
  end: Vec2;
  radius: number;
}

interface ReactionPhaseState {
  intent: 'MOVE' | 'RALLY';
  /** Which command will be dispatched when the reaction phase confirms. */
  commandType:
    | 'MOVE'
    | 'CRAWL'
    | 'VAULT'
    | 'CLIMB'
    | 'TRAVERSE'
    | 'RALLY'
    | 'COMMAND_MOVE'
    | 'COMMAND_RALLY'
    | 'PASS_DOOR';
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
  private terrainTooltipEl: HTMLElement | null = null;
  private terrainTooltipAlt = false;
  private objectivesGfx!: Phaser.GameObjects.Graphics;
  private objectiveLabels: Phaser.GameObjects.Text[] = [];
  private poisGfx!: Phaser.GameObjects.Graphics;
  // LOS overlay uses two visible Graphics layers + two off-display mask
  // Graphics. Each layer is masked by the corresponding visibility polygon
  // with `invertAlpha = true`, so the layer fills exactly where the mask
  // is *empty* — yielding "bounds minus polygon" without polygon-with-hole
  // triangulation (which fails when the inner polygon touches bounds).
  private losOverlayBgGfx!: Phaser.GameObjects.Graphics;
  private losOverlayFgGfx!: Phaser.GameObjects.Graphics;
  private losMaskBlockGfx!: Phaser.GameObjects.Graphics;
  private losMaskClearGfx!: Phaser.GameObjects.Graphics;
  /** Lines from the previewed unit to every visible ally/enemy. */
  private losLinesGfx!: Phaser.GameObjects.Graphics;
  /** Cover-source labels at midpoint of each enemy LOS line. */
  private losLineLabels: Phaser.GameObjects.Text[] = [];
  /** Unit currently used to source the LOS preview overlay (hover state). */
  private losPreviewUnitId: string | null = null;
  /**
   * Fog-of-war overlay (no-intel missions). Opaque-black layer that fills
   * the battlefield outside the union of friendly visibility polygons.
   * Mask graphics is the union (drawn from each alive faction-A unit).
   * `friendlyVisionPolys` caches the polygons for the per-enemy hit-test
   * that hides their containers outside the union.
   */
  private fogOverlayGfx!: Phaser.GameObjects.Graphics;
  private fogMaskGfx!: Phaser.GameObjects.Graphics;
  private noIntelActive = false;
  private friendlyVisionPolys: Vec2[][] = [];
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
  /** Hold-V tactical overview saved camera state for restore on key release. */
  private overviewSavedView: { zoom: number; scrollX: number; scrollY: number } | null = null;
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

  init(data: {
    initialState?: GameState;
    runState?: import('../../runs/state').RunState;
    manualPlayerDeployment?: ReadonlyArray<
      import('../../core/setup/types').DeploymentPlacement
    >;
  }): void {
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
            stealthActive: currentMissionStealthActive(data.runState, mission),
            ...(data.manualPlayerDeployment
              ? { manualPlayerDeployment: data.manualPlayerDeployment }
              : {}),
          },
        );
        this.noIntelActive = currentMissionNoIntelActive(
          data.runState,
          mission,
        );
      }
    } else if (data?.initialState) {
      this.gameState = data.initialState;
      this.noIntelActive = false;
    } else {
      this.gameState = setupDemoState();
      this.noIntelActive = false;
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
    this.overviewSavedView = null;
    this.losPreviewUnitId = null;
  }

  create(): void {
    showBattleHud();
    this.replayLog = createReplayLog(this.gameState);
    this.cameras.main.setBackgroundColor('#0a0c0a');

    this.boardEdgeGfx = this.add.graphics();
    this.terrainGfx = this.add.graphics();
    this.objectivesGfx = this.add.graphics();
    // POI markers (stealth) draw above objectives but under the LOS overlay
    // so they don't interfere with sight-line debug viz.
    this.poisGfx = this.add.graphics();
    // LOS overlay sits between objectives and units so unit circles and
    // their labels remain on top — the overlay is just visual hint
    // material, never selection-blocking. Two layers stacked: bg (0.55,
    // outside vBlock) and fg (0.25, inside vBlock minus vClear). Masks
    // are off-display Graphics whose polygons are redrawn each frame.
    this.losOverlayBgGfx = this.add.graphics();
    this.losOverlayFgGfx = this.add.graphics();
    this.losMaskBlockGfx = this.make.graphics({ x: 0, y: 0 }, false);
    this.losMaskClearGfx = this.make.graphics({ x: 0, y: 0 }, false);
    const blockMask = this.losMaskBlockGfx.createGeometryMask();
    blockMask.invertAlpha = true;
    const clearMask = this.losMaskClearGfx.createGeometryMask();
    clearMask.invertAlpha = true;
    this.losOverlayBgGfx.setMask(blockMask);
    this.losOverlayFgGfx.setMask(clearMask);
    // LOS preview lines sit above the shaded overlay but under unit
    // circles/labels so they don't obscure unit identity.
    this.losLinesGfx = this.add.graphics();
    this.unitLayer = this.add.container();
    // Fog-of-war (no-intel): opaque black fill above units so enemy
    // sprites outside the friendly LOS union are visually painted over.
    // Mask is the union of every alive friendly unit's visibility
    // polygon, drawn into an off-display Graphics with invertAlpha.
    this.fogOverlayGfx = this.add.graphics();
    this.fogMaskGfx = this.make.graphics({ x: 0, y: 0 }, false);
    const fogMask = this.fogMaskGfx.createGeometryMask();
    fogMask.invertAlpha = true;
    this.fogOverlayGfx.setMask(fogMask);
    this.effectsLayer = this.add.container();
    this.effects = new CombatEffects(this, this.effectsLayer);
    this.aimGfx = this.add.graphics();

    this.fitCamera();
    const resizeHandler = () => this.fitCamera();
    this.scale.on('resize', resizeHandler);
    this.terrainTooltipEl = document.getElementById('terrain-tooltip');
    this.terrainTooltipAlt = false;
    this.events.once('shutdown', () => {
      this.scale.off('resize', resizeHandler);
      this.hud?.hideUnitDetails();
      this.hideTerrainTooltip();
    });

    this.renderTerrain();
    this.renderObjectives();
    this.renderPois();
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
        // pointer.x/y are canvas-space and Phaser updates them on the wheel
        // event, so they already match the cursor — no clientX/rect math.
        this.zoomCameraAt(pointer.x, pointer.y, factor);
      },
    );
    this.input.keyboard?.on('keydown-ESC', () => {
      // Reaction phase is intentionally not cancellable — handoff is final.
      if (this.aimMode === 'aim-move') this.cancelAim();
      else if (this.aimMode === 'aim-shoot' || this.aimMode === 'aim-melee')
        this.cancelAim();
    });
    this.input.keyboard?.on('keydown-R', () => this.resetCamera());
    // Hold V for tactical overview (fit-to-map); release to restore close-up.
    this.input.keyboard?.on('keydown-V', (e: KeyboardEvent) => {
      if (e.repeat) return;
      this.startOverview();
    });
    this.input.keyboard?.on('keyup-V', () => this.endOverview());
    this.input.keyboard?.on('keydown-ALT', (e: KeyboardEvent) => {
      e.preventDefault();
      this.terrainTooltipAlt = true;
      // Re-render tooltip with detail content if one is already visible.
      if (this.terrainTooltipEl?.classList.contains('visible')) {
        const wp = this.cameras.main.getWorldPoint(
          this.input.activePointer.x,
          this.input.activePointer.y,
        );
        this.updateTerrainTooltip(wp, this.input.activePointer.x, this.input.activePointer.y);
      }
    });
    this.input.keyboard?.on('keyup-ALT', () => {
      this.terrainTooltipAlt = false;
      if (this.terrainTooltipEl?.classList.contains('visible')) {
        const wp = this.cameras.main.getWorldPoint(
          this.input.activePointer.x,
          this.input.activePointer.y,
        );
        this.updateTerrainTooltip(wp, this.input.activePointer.x, this.input.activePointer.y);
      }
    });

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
  /**
   * Default close-up zoom: sprites are authored at 64×64 native and rendered at
   * ~30 world px diameter, so zoom 2.0 displays them near 1:1 with the source
   * art. Players hold V for a fit-to-map tactical overview.
   */
  private static readonly DEFAULT_CAMERA_ZOOM = 2.0;

  /** Computes the fit-to-map zoom + center used for tactical overview. */
  private computeOverviewView(): { zoom: number; cx: number; cy: number } {
    const cam = this.cameras.main;
    const availW = Math.max(200, cam.width - BattleScene.HUD_RIGHT_PX);
    const availH = Math.max(
      200,
      cam.height - BattleScene.HUD_TOP_PX - BattleScene.HUD_BOTTOM_PX,
    );
    const margin = 0.94;
    const zoom =
      Math.min(availW / BATTLEFIELD_SIZE_PIXELS, availH / BATTLEFIELD_SIZE_PIXELS) *
      margin;
    const offsetX = -BattleScene.HUD_RIGHT_PX / 2;
    const offsetY = (BattleScene.HUD_TOP_PX - BattleScene.HUD_BOTTOM_PX) / 2;
    return {
      zoom,
      cx: BATTLEFIELD_SIZE_PIXELS / 2 + offsetX / zoom,
      cy: BATTLEFIELD_SIZE_PIXELS / 2 + offsetY / zoom,
    };
  }

  /** Centroid of own-faction (A) survivors, falling back to map center. */
  private ownFactionCentroid(): { x: number; y: number } {
    const own = this.gameState.units.filter(
      (u) => u.faction === 'A' && isUnitAlive(u),
    );
    if (own.length === 0) {
      return {
        x: BATTLEFIELD_SIZE_PIXELS / 2,
        y: BATTLEFIELD_SIZE_PIXELS / 2,
      };
    }
    const sum = own.reduce(
      (acc, u) => ({ x: acc.x + u.position.x, y: acc.y + u.position.y }),
      { x: 0, y: 0 },
    );
    return { x: sum.x / own.length, y: sum.y / own.length };
  }

  private fitCamera(): void {
    if (this.cameraManualOverride) {
      this.drawBoardEdge();
      return;
    }
    const cam = this.cameras.main;
    const zoom = BattleScene.DEFAULT_CAMERA_ZOOM;
    cam.setZoom(zoom);
    const c = this.ownFactionCentroid();
    const offsetX = -BattleScene.HUD_RIGHT_PX / 2;
    const offsetY = (BattleScene.HUD_TOP_PX - BattleScene.HUD_BOTTOM_PX) / 2;
    cam.centerOn(c.x + offsetX / zoom, c.y + offsetY / zoom);
    this.drawBoardEdge();
  }

  private resetCamera(): void {
    this.cameraManualOverride = false;
    this.overviewSavedView = null;
    this.fitCamera();
  }

  private startOverview(): void {
    if (this.overviewSavedView) return;
    const cam = this.cameras.main;
    this.overviewSavedView = {
      zoom: cam.zoom,
      scrollX: cam.scrollX,
      scrollY: cam.scrollY,
    };
    const { zoom, cx, cy } = this.computeOverviewView();
    cam.zoomTo(zoom, 150);
    cam.pan(cx, cy, 150);
  }

  private endOverview(): void {
    const saved = this.overviewSavedView;
    if (!saved) return;
    this.overviewSavedView = null;
    const cam = this.cameras.main;
    cam.zoomTo(saved.zoom, 150);
    // pan() targets the center; convert scroll back to a center point.
    const cx = saved.scrollX + cam.width / (2 * saved.zoom);
    const cy = saved.scrollY + cam.height / (2 * saved.zoom);
    cam.pan(cx, cy, 150);
  }

  private zoomCameraAt(screenX: number, screenY: number, factor: number): void {
    const cam = this.cameras.main;
    const oldZoom = cam.zoom;
    const newZoom = Phaser.Math.Clamp(oldZoom * factor, 0.4, 6);
    if (newZoom === oldZoom) {
      this.cameraManualOverride = true;
      this.drawBoardEdge();
      return;
    }
    // Closed-form anchor-on-cursor: Phaser's camera matrix only refreshes in
    // preRender, so calling getWorldPoint twice (before+after setZoom) reads
    // the stale matrix the second time and the delta collapses to zero —
    // which made zoom drift toward the camera center every wheel tick.
    // For default origin (0.5,0.5) and viewport (0,0,W,H), screen↔world is:
    //   screenX = (worldX - scrollX) * zoom + W/2
    // Keeping worldX fixed under the cursor through a zoom change yields:
    //   newScrollX = oldScrollX + (screenX - W/2) * (1/oldZoom - 1/newZoom)
    const dxFactor = 1 / oldZoom - 1 / newZoom;
    cam.setZoom(newZoom);
    cam.scrollX += (screenX - cam.width / 2) * dxFactor;
    cam.scrollY += (screenY - cam.height / 2) * dxFactor;
    this.cameraManualOverride = true;
  }

  private drawBoardEdge(): void {
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

  private renderTerrain(): void {
    this.terrainGfx.clear();
    for (const lbl of this.terrainLabels) lbl.destroy();
    this.terrainLabels = [];
    for (const t of this.gameState.terrain) {
      drawTerrain(this.terrainGfx, t);
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
    this.losOverlayBgGfx.clear();
    this.losOverlayFgGfx.clear();
    this.losMaskBlockGfx.clear();
    this.losMaskClearGfx.clear();
    this.losLinesGfx.clear();
    for (const t of this.losLineLabels) t.destroy();
    this.losLineLabels = [];
    if (!unitId) return;
    const unit = this.gameState.units.find((u) => u.id === unitId);
    if (!unit || !isUnitAlive(unit)) return;

    // Two visibility polygons — vector geometry, no grid quantization:
    //   V_block: only fully-blocking walls are occluders. Bounds-minus
    //            this is the "fully shadowed" region (alpha 0.55).
    //   V_clear: also treats partial-cover sources (soft, low walls
    //            against standing) as occluders. V_block-minus-V_clear
    //            is the "visible-but-with-cover" region (alpha 0.25).
    // Soft polygon containing the shooter doesn't occlude (matches
    // buildLosBlockers' "if either endpoint inside" rule); when it
    // happens, every visible cell is partial and we just shade V_block.
    const prone = unit.stance === 'PRONE';
    const hardHighPolys = this.gameState.terrain
      .filter(
        (t) =>
          (t.kind === 'HARD' &&
            !isLowWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS)) ||
          t.kind === 'BLOCKER' ||
          t.kind === 'OUT_OF_BOUNDS',
      )
      .map((t) => t.polygon);
    const lowWallPolys = this.gameState.terrain
      .filter(
        (t) => t.kind === 'HARD' && isLowWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS),
      )
      .map((t) => t.polygon);
    const softPolys = this.gameState.terrain
      .filter((t) => t.kind === 'SOFT')
      .map((t) => t.polygon);

    const blockingPolys = prone
      ? [...hardHighPolys, ...lowWallPolys]
      : hardHighPolys;
    const originInsideSoft = softPolys.some((p) =>
      isPointInPolygon(unit.position, p),
    );
    const partialOnlyLowWalls = prone ? [] : lowWallPolys;
    const partialBlockers = [
      ...blockingPolys,
      ...partialOnlyLowWalls,
      ...(originInsideSoft ? [] : softPolys),
    ];

    const bounds = {
      width: BATTLEFIELD_SIZE_PIXELS,
      height: BATTLEFIELD_SIZE_PIXELS,
    };
    const vBlock = computeVisibilityPolygon(
      unit.position,
      blockingPolys,
      bounds,
    );
    const vClear =
      partialBlockers.length === blockingPolys.length
        ? vBlock
        : computeVisibilityPolygon(unit.position, partialBlockers, bounds);

    // Shadow tier (0.55): full bounds rect, masked by vBlock with
    // invertAlpha — paints everything OUTSIDE the visibility polygon.
    if (vBlock.length >= 3) {
      drawPolygonPath(this.losMaskBlockGfx, vBlock);
    }
    this.losOverlayBgGfx.fillStyle(0x000000, 0.55);
    this.losOverlayBgGfx.fillRect(0, 0, bounds.width, bounds.height);

    // Partial tier (0.25): fill vBlock interior, masked by vClear with
    // invertAlpha — paints the vBlock-minus-vClear "covered" region.
    if (vBlock.length >= 3) {
      this.losOverlayFgGfx.fillStyle(0x000000, 0.25);
      this.losOverlayFgGfx.beginPath();
      this.losOverlayFgGfx.moveTo(vBlock[0]!.x, vBlock[0]!.y);
      for (let i = 1; i < vBlock.length; i++) {
        this.losOverlayFgGfx.lineTo(vBlock[i]!.x, vBlock[i]!.y);
      }
      this.losOverlayFgGfx.closePath();
      this.losOverlayFgGfx.fillPath();
      // When the shooter is inside soft, or vClear is degenerate, leave the
      // clear mask empty — the whole vBlock interior reads as partial cover.
      if (!originInsideSoft && vClear.length >= 3 && vClear !== vBlock) {
        drawPolygonPath(this.losMaskClearGfx, vClear);
      }
    }

    this.drawLosPreviewLines(unit);
  }

  /**
   * Draw a line from the previewed unit to every other alive unit it can
   * actually shoot (per `effectiveLOS`, the same predicate shooting uses).
   * Allies get a thin cyan line; enemies get a thicker red line plus a
   * label listing the cover sources that would apply on a shot.
   */
  private drawLosPreviewLines(observer: Unit): void {
    const observerOnHigh = isOnHighGround(observer, this.gameState.terrain);
    const observerProne = observer.stance === 'PRONE';
    for (const other of this.gameState.units) {
      if (other.id === observer.id) continue;
      if (!isUnitAlive(other)) continue;
      if (
        observer.position.x === other.position.x &&
        observer.position.y === other.position.y
      ) {
        continue;
      }
      const otherOnHigh = isOnHighGround(other, this.gameState.terrain);
      const otherProne = other.stance === 'PRONE';
      const visible = effectiveLOS(
        observer,
        other,
        this.gameState,
        this.gameState.terrain,
        {
          aProne: observerProne,
          bProne: otherProne,
          aOnHighGround: observerOnHigh,
          bOnHighGround: otherOnHigh,
        },
      );
      if (!visible) continue;

      const ally = other.faction === observer.faction;
      const color = ally ? 0x66ccff : 0xff5e4a;
      const alpha = ally ? 0.7 : 0.85;
      this.losLinesGfx.lineStyle(1, color, alpha);
      this.losLinesGfx.beginPath();
      this.losLinesGfx.moveTo(observer.position.x, observer.position.y);
      this.losLinesGfx.lineTo(other.position.x, other.position.y);
      this.losLinesGfx.strokePath();

      if (ally) continue;
      const detail = coverDetail(observer, other, this.gameState.terrain);
      const sources: string[] = [];
      if (detail.prone) sources.push('趴地');
      if (detail.highGround) sources.push('高地');
      if (detail.difficult) sources.push('困難地形');
      if (detail.soft) sources.push('煙霧');
      if (detail.hardWall) sources.push('矮牆');
      const label = sources.length === 0 ? '無掩體' : sources.join(', ');
      const mx = (observer.position.x + other.position.x) / 2;
      const my = (observer.position.y + other.position.y) / 2;
      const text = this.add.text(mx, my, label, {
        fontFamily: 'sans-serif',
        fontSize: '10px',
        color: '#ffffff',
        backgroundColor: 'rgba(0,0,0,0.6)',
        padding: { left: 3, right: 3, top: 1, bottom: 1 },
      });
      text.setOrigin(0.5);
      this.losLineLabels.push(text);
    }
  }

  /**
   * Resolve which unit's data the top-left detail card should show. Hovered
   * unit wins while the cursor sits on it (transient inspection), otherwise
   * we fall back to the clicked / pinned `selectedUnitId` so the panel
   * stays visible after the player moves the mouse away. Called from hover,
   * click, AND every refreshHud() so combat state updates flow through.
   */
  private updateUnitDetailPanel(): void {
    const id = this.losPreviewUnitId ?? this.selectedUnitId;
    const weaponUsage = this.gameState.initiative.activeActivation?.weaponUsage;
    if (id === null) {
      this.hud.showUnitDetails(null, weaponUsage);
      return;
    }
    const u = this.gameState.units.find((x) => x.id === id);
    this.hud.showUnitDetails(u ?? null, weaponUsage);
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
    const isControlPoints = this.missionScenario === 'control-points';
    const ownerMap = this.gameState.initiative.objectiveControl ?? {};
    for (const o of objs) {
      // Control-points: tint by owner so capture status reads at a glance.
      let drawColor = color;
      let drawPrefix = prefix;
      if (isControlPoints) {
        const owner = ownerMap[o.id];
        if (owner === 'A') {
          drawColor = 0x4a8acf;
          drawPrefix = 'A';
        } else if (owner === 'B') {
          drawColor = 0xcf5a4a;
          drawPrefix = 'B';
        } else {
          drawColor = 0xcfcfcf;
          drawPrefix = '中';
        }
      }
      this.objectivesGfx.fillStyle(drawColor, 0.12);
      this.objectivesGfx.fillCircle(o.position.x, o.position.y, o.radius);
      this.objectivesGfx.lineStyle(2, drawColor, 0.85);
      this.objectivesGfx.strokeCircle(o.position.x, o.position.y, o.radius);
      // Centre cross-hair for legibility
      this.objectivesGfx.lineStyle(1, drawColor, 0.7);
      this.objectivesGfx.beginPath();
      this.objectivesGfx.moveTo(o.position.x - o.radius * 0.3, o.position.y);
      this.objectivesGfx.lineTo(o.position.x + o.radius * 0.3, o.position.y);
      this.objectivesGfx.moveTo(o.position.x, o.position.y - o.radius * 0.3);
      this.objectivesGfx.lineTo(o.position.x, o.position.y + o.radius * 0.3);
      this.objectivesGfx.strokePath();
      const labelText = drawPrefix
        ? `${drawPrefix} ${o.displayName ?? '目標'}`
        : (o.displayName ?? '目標');
      const lbl = this.add.text(
        o.position.x,
        o.position.y + o.radius + 6,
        labelText,
        {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '10px',
          color: `#${drawColor.toString(16).padStart(6, '0')}`,
        },
      );
      lbl.setOrigin(0.5, 0);
      lbl.setAlpha(0.85);
      this.objectiveLabels.push(lbl);
    }
  }

  /**
   * Stealth POI markers — small yellow diamonds at each `state.stealth.pois`
   * position. Cleared and redrawn from scratch each frame so creation +
   * decay tracks the reducer state without per-event bookkeeping. No-op
   * when stealth is absent or POI list is empty.
   */
  private renderPois(): void {
    this.poisGfx.clear();
    const pois = this.gameState.stealth?.pois ?? [];
    if (pois.length === 0) return;
    const size = 7;
    for (const p of pois) {
      this.poisGfx.fillStyle(0xffd166, 0.55);
      this.poisGfx.lineStyle(1.5, 0xffd166, 0.95);
      this.poisGfx.beginPath();
      this.poisGfx.moveTo(p.position.x, p.position.y - size);
      this.poisGfx.lineTo(p.position.x + size, p.position.y);
      this.poisGfx.lineTo(p.position.x, p.position.y + size);
      this.poisGfx.lineTo(p.position.x - size, p.position.y);
      this.poisGfx.closePath();
      this.poisGfx.fillPath();
      this.poisGfx.strokePath();
    }
  }

  private renderUnits(): void {
    // POI markers track stealth state mutations one-for-one with command
    // dispatch, so refresh them on the same beat as units.
    this.renderPois();
    // Recompute fog before per-unit visibility so the cached friendly
    // vision polys are up to date. Cheap no-op when no_intel inactive.
    this.renderFog();
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
      // Belt-and-suspenders: hide enemy containers entirely when their
      // centre lies outside every friendly vision polygon. The fog
      // overlay paints over them visually too, but flipping `visible`
      // also masks any selection ring / labels and avoids interactive
      // hit-tests on hidden enemies.
      if (this.noIntelActive && u.faction !== 'A') {
        const seen = this.friendlyVisionPolys.some((poly) =>
          isPointInPolygon(u.position, { vertices: poly }),
        );
        container.setVisible(seen);
      } else {
        container.setVisible(true);
      }
    }
  }

  /**
   * Paint the fog-of-war overlay used by no-intel missions: opaque
   * black covering everything outside the union of friendly visibility
   * polygons. Caches each polygon for the per-enemy hit-test in
   * `renderUnits`. No-op when `noIntelActive` is false.
   */
  private renderFog(): void {
    this.fogOverlayGfx.clear();
    this.fogMaskGfx.clear();
    this.friendlyVisionPolys = [];
    if (!this.noIntelActive) return;
    const bounds = {
      width: BATTLEFIELD_SIZE_PIXELS,
      height: BATTLEFIELD_SIZE_PIXELS,
    };
    // Use the same blocker set as the LOS overlay's hard tier (high
    // walls + BLOCKER + OOB + low walls when prone) so the fog edge
    // matches what the player perceives as "I can see this cell".
    const hardHighPolys = this.gameState.terrain
      .filter(
        (t) =>
          (t.kind === 'HARD' &&
            !isLowWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS)) ||
          t.kind === 'BLOCKER' ||
          t.kind === 'OUT_OF_BOUNDS',
      )
      .map((t) => t.polygon);
    const lowWallPolys = this.gameState.terrain
      .filter(
        (t) => t.kind === 'HARD' && isLowWall(t, VAULT_HEIGHT_THRESHOLD_PIXELS),
      )
      .map((t) => t.polygon);
    this.fogOverlayGfx.fillStyle(0x000000, 1.0);
    this.fogOverlayGfx.fillRect(0, 0, bounds.width, bounds.height);
    for (const u of this.gameState.units) {
      if (u.faction !== 'A' || !isUnitAlive(u)) continue;
      const blockers =
        u.stance === 'PRONE'
          ? [...hardHighPolys, ...lowWallPolys]
          : hardHighPolys;
      const poly = computeVisibilityPolygon(u.position, blockers, bounds);
      if (poly.length < 3) continue;
      this.friendlyVisionPolys.push(poly);
      drawPolygonPath(this.fogMaskGfx, poly);
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

    // Optional sprite layer — shown only when the unit's template registers
    // a `spriteKey` AND the corresponding texture is loaded. When shown,
    // the ring's fill is hidden so the sprite displays cleanly; the stroke
    // still carries selection / activation feedback.
    //
    // Faction tint is applied as a translucent solid-fill copy of the sprite
    // *on top* of the original (NOT setTint, which is multiplicative and
    // crushes shaded areas to near-black). This preserves the sprite's
    // internal contrast while making the faction colour read clearly on
    // the bright/white parts.
    if (u.templateId) {
      const tmpl = listUnitTemplates().find(
        (t) => t.templateId === u.templateId,
      );
      const tint = tmpl ? resolveFactionColorForTags(tagsOf(tmpl)) : null;
      const size = u.radius * 2.4;
      const addSprite = (
        texKey: string,
        baseName: 'sprite' | 'spriteProne',
      ): void => {
        const spr = this.add.sprite(0, 0, texKey);
        spr.setDisplaySize(size, size);
        spr.setName(baseName);
        container.add(spr);
        if (tint !== null) {
          const overlay = this.add.sprite(0, 0, texKey);
          overlay.setDisplaySize(size, size);
          overlay.setName(`${baseName}Tint`);
          overlay.setTintFill(tint);
          overlay.setAlpha(TINT_OVERLAY_ALPHA);
          container.add(overlay);
        }
      };
      const texKey = tmpl?.spriteKey ?? null;
      if (texKey && this.textures.exists(texKey)) {
        addSprite(texKey, 'sprite');
        arc.setFillStyle(FACTION_COLOR[u.faction], 0);
      }
      const proneKey = tmpl?.spriteKeyProne ?? null;
      if (proneKey && this.textures.exists(proneKey)) {
        addSprite(proneKey, 'spriteProne');
        arc.setFillStyle(FACTION_COLOR[u.faction], 0);
      }
    }

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
    for (const name of ['sprite', 'spriteTint', 'spriteProne', 'spriteProneTint']) {
      const spr = container.getByName(name) as Phaser.GameObjects.Sprite | null;
      if (spr) spr.rotation = initial;
    }

    return container;
  }

  private setUnitFacing(unitId: string, angle: number): void {
    this.unitFacings.set(unitId, angle);
    const c = this.unitContainers.get(unitId);
    if (!c) return;
    const chev = c.getByName('facing') as Phaser.GameObjects.Graphics | null;
    if (chev) chev.rotation = angle;
    for (const name of ['sprite', 'spriteTint', 'spriteProne', 'spriteProneTint']) {
      const spr = c.getByName(name) as Phaser.GameObjects.Sprite | null;
      if (spr) spr.rotation = angle;
    }
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

    // Active-unit glow: faction-colored preFX glow on the currently activated
    // unit's arc. Clear first so re-renders don't stack additional FX layers.
    // preFX requires WebGL (Phaser config uses Phaser.AUTO which prefers WebGL).
    arc.preFX?.clear();
    if (isActive) {
      arc.preFX?.addGlow(FACTION_COLOR[u.faction], 6, 0);
    }

    // Prone visual: dim fill + show "PRONE" stance tag. Chevron also dims so
    // the unit reads as low-profile from above. When a dedicated prone
    // sprite exists, swap to it (no dim — the sprite itself signals prone);
    // otherwise dim the standing sprite as the only prone indicator.
    const sprite = container.getByName('sprite') as
      | Phaser.GameObjects.Sprite
      | null;
    const spriteTint = container.getByName('spriteTint') as
      | Phaser.GameObjects.Sprite
      | null;
    const spriteProne = container.getByName('spriteProne') as
      | Phaser.GameObjects.Sprite
      | null;
    const spriteProneTint = container.getByName('spriteProneTint') as
      | Phaser.GameObjects.Sprite
      | null;
    const isProne = u.stance === 'PRONE';
    if (sprite || spriteProne) {
      arc.setFillStyle(FACTION_COLOR[u.faction], 0);
      if (spriteProne) {
        const showProne = isProne;
        spriteProne.setVisible(showProne);
        if (spriteProneTint) spriteProneTint.setVisible(showProne);
        if (sprite) sprite.setVisible(!showProne);
        if (spriteTint) spriteTint.setVisible(!showProne);
        // Dedicated prone art carries the state — no extra dim.
        if (spriteProne) spriteProne.setAlpha(1);
        if (spriteProneTint) spriteProneTint.setAlpha(TINT_OVERLAY_ALPHA);
        if (sprite) sprite.setAlpha(1);
        if (spriteTint) spriteTint.setAlpha(TINT_OVERLAY_ALPHA);
      } else if (sprite) {
        const proneAlpha = isProne ? 0.55 : 1;
        sprite.setAlpha(proneAlpha);
        if (spriteTint) spriteTint.setAlpha(proneAlpha * TINT_OVERLAY_ALPHA);
      }
    } else {
      arc.setFillStyle(FACTION_COLOR[u.faction], isProne ? 0.55 : 1);
    }
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

    // Initiative-state tag above the unit: 🔒 (locked this initiative — can't
    // be re-activated or join a command/focused/combined call) and 🛡 (already
    // reacted this round — no more reaction fire until handover). Both fade
    // away on INITIATIVE_TURNOVER (engine clears the flags).
    let statusTag = container.getByName('status-tag') as
      | Phaser.GameObjects.Text
      | null;
    const statusText =
      (u.lockedThisInitiative ? '🔒' : '') +
      (u.cannotReactThisRound ? '🛡' : '');
    if (statusText.length > 0) {
      if (!statusTag) {
        statusTag = this.add.text(0, -(u.radius + 11), statusText, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '11px',
          color: '#ffd166',
        });
        statusTag.setName('status-tag');
        statusTag.setOrigin(0.5);
        container.add(statusTag);
      } else {
        statusTag.setText(statusText);
      }
    } else if (statusTag) {
      statusTag.destroy();
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

  /**
   * Pick a screen anchor for stealth-state floaters that aren't tied to
   * a specific unit (STEALTH_BROKEN, STEALTH_PENDING_BREAK). First alive
   * player unit is "good enough" — keeps the toast inside the action area
   * and avoids tying it to a dead unit's last known position.
   */
  private firstPlayerAnchor(): { x: number; y: number } | null {
    for (const u of this.gameState.units) {
      if (u.faction === 'A' && isUnitAlive(u)) {
        return { x: u.position.x, y: u.position.y - u.radius - 18 };
      }
    }
    return null;
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
    this.updateUnitDetailPanel();
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
      // Track the longest animation tail so the turnover banner can wait
      // until all unit motion / shot effects / melee clash visuals have
      // played out before taking over the screen.
      let animTailMs = 0;
      let pendingTurnover:
        | { to: 'A' | 'B'; reason: TurnoverReason }
        | null = null;
      for (const ev of result.events) {
        if (ev.type === 'MOVE_RESOLVED') {
          const dx = ev.to.x - ev.from.x;
          const dy = ev.to.y - ev.from.y;
          const dist = Math.hypot(dx, dy);
          const dur = Math.max(
            MOVEMENT_TWEEN_MIN_MS,
            (dist / UNIT_DISTANCE_PIXELS) * MOVEMENT_MS_PER_UD,
          );
          animTailMs = Math.max(animTailMs, dur);
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
            // Shot tail: arrival ~130ms + per-extra-shooter 35ms + worst-case
            // kill-marker chain ~400ms. 700ms covers the typical case.
            animTailMs = Math.max(animTailMs, 700);
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
          if (att && def) {
            this.playMeleeEffects(ev, att, def);
            animTailMs = Math.max(animTailMs, 500);
          }
        }
        if (ev.type === 'IMPULSIVE_TRIGGERED') {
          const u = this.gameState.units.find((x) => x.id === ev.unitId);
          if (u) {
            const actionLabel =
              ev.action === 'SHOOT'
                ? '射擊'
                : ev.action === 'MOVE'
                  ? '移動'
                  : '無行動';
            this.effects.hitFloater(
              { x: u.position.x, y: u.position.y - u.radius - 6 },
              `⚡ 衝動 → ${actionLabel}`,
              '#ffd166',
            );
          }
        }
        if (ev.type === 'PATROL_TRIGGERED') {
          const u = this.gameState.units.find((x) => x.id === ev.unitId);
          if (u) {
            this.effects.hitFloater(
              { x: u.position.x, y: u.position.y - u.radius - 6 },
              '👁 巡邏',
              '#b8c8ff',
            );
          }
        }
        if (ev.type === 'STEALTH_PENDING_BREAK') {
          const anchor = this.firstPlayerAnchor();
          if (anchor) {
            this.effects.hitFloater(
              anchor,
              `🌙 暴露已延後 (${ev.reason === 'SHOT' ? '開火' : '視線'})`,
              '#ffd166',
            );
          }
        }
        if (ev.type === 'STEALTH_BROKEN') {
          const anchor = this.firstPlayerAnchor();
          if (anchor) {
            const label = ev.deferred
              ? `⚠ 暴露 (延後兌現)`
              : `⚠ 暴露！(${ev.reason === 'SHOT' ? '開火' : '視線'})`;
            this.effects.hitFloater(anchor, label, '#ff5050');
          }
        }
        if (ev.type === 'INITIATIVE_TURNOVER') {
          // Defer to after all unit-motion / shot / melee animations so the
          // banner doesn't cover up the action that caused the turnover.
          pendingTurnover = { to: ev.to, reason: ev.reason };
        }
        if (this.isRollEvent(ev)) {
          this.showRollOverlay(ev, overlayIndex++);
        }
      }
      if (pendingTurnover !== null) {
        const t = pendingTurnover;
        if (animTailMs <= 0) {
          this.showTurnoverBanner(t.to, t.reason);
        } else {
          this.time.delayedCall(animTailMs, () => {
            this.showTurnoverBanner(t.to, t.reason);
          });
        }
      }
      this.maybeScheduleAiTick();
      this.checkVictory();
    } catch (e) {
      const message = e instanceof CommandError ? e.message : String(e);
      this.hud.pushError(message);
      // Defensive AI recovery: if the AI side dispatched a bad command we
      // would otherwise sit forever — the next tick would just produce the
      // same broken plan and re-throw. Gracefully fold the activation (or
      // pass initiative) so play advances, then reschedule. Skipped when
      // the failing command was already a recovery primitive — nothing
      // safer to fall back to.
      const holder = this.gameState.initiative.holder;
      const isRecoveryCmd =
        cmd.type === 'END_ACTIVATION' || cmd.type === 'PASS_INITIATIVE';
      if (this.aiControlled[holder] && !isRecoveryCmd) {
        const recovery: Command = this.gameState.initiative.activeActivation
          ? { type: 'END_ACTIVATION' }
          : { type: 'PASS_INITIATIVE' };
        try {
          const result = applyCommand(this.gameState, recovery);
          this.gameState = result.state;
          this.replayLog = appendCommand(this.replayLog, recovery);
          this.hud.pushEvents(result.events);
          this.refreshHud();
          this.renderUnits();
          this.maybeScheduleAiTick();
        } catch (recoveryErr) {
          const rmsg =
            recoveryErr instanceof CommandError
              ? recoveryErr.message
              : String(recoveryErr);
          this.hud.pushError(`AI 復原失敗: ${rmsg}`);
        }
      }
    }
  }

  private victoryFired = false;
  /**
   * Sandbox fallback tiebreak: when no scenario is in play, force a
   * verdict after this many initiative cycles to prevent forever-stalls.
   */
  private static readonly SANDBOX_CYCLE_TIEBREAK = 8;

  /**
   * Victory rules:
   *  - Scenario-aware path via `detectScenarioVictory` covers ELIMINATED,
   *    engage-reach OBJECTIVE_SECURED, defend hold-the-line, and extract
   *    success/failure. Mirrors the sim's runMatch logic so live play and
   *    sim runs reach the same verdict on identical states.
   *  - Sandbox fallback: a hard cycle-count tiebreak prevents forever-stalls
   *    (alive-and-not-suppressed count decides the winner).
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
    } else if (
      this.gameState.initiative.cycle > BattleScene.SANDBOX_CYCLE_TIEBREAK
    ) {
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
      finalCycle: this.gameState.initiative.cycle,
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
      // Stealth break carry-over: only meaningful when the mission was
      // launched in stealth (state.stealth present going in). The reducer
      // flips state.stealth.active to false on break; we surface that into
      // MissionResult so chain stealth can decay across the operation.
      const stealthBroken =
        this.gameState.stealth !== undefined &&
        this.gameState.stealth.active === false;
      const completedMissionDef = getMissionById(completedMission);
      const result: MissionResult = {
        missionId: completedMission,
        winner,
        survivorIds,
        losses,
        ...(stealthBroken ? { stealthBroken: true } : {}),
      };
      const advanced = advanceAfterMission(
        this.runState,
        result,
        damageCarry,
        completedMissionDef.stealthMode,
        completedMissionDef.noIntelMode,
        completedMissionDef.deploymentSlotsMode,
      );
      // Persist post-mission run state so a tab close lands cleanly back
      // here on resume (either at Hub for next stage, or RunResult). The
      // RunResultScene clears this slot once the campaign-side advance
      // commits.
      if (advanced.inCampaign) {
        // Defer the import to avoid pulling persist into sandbox-only paths.
        import('../../runs/persist').then((m) => m.saveRun(advanced));
      }
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
  /**
   * Cheap eligibility check for the reaction-phase auto-skip optimisation.
   * Mirrors the conditions reducer / planReactions enforce on a defender:
   * alive, not locked-this-initiative, not cannot-react-this-round, not
   * SUPPRESSED, and owns at least one SHOOT weapon with a REACTION mode.
   * If no defender unit qualifies, the reaction phase has no possible
   * outcome other than an empty plan — auto-skipping spares the player a
   * pointless Confirm click (especially in sandbox mode where both sides
   * are human-controlled).
   */
  private defenderHasAnyEligibleReactor(defender: 'A' | 'B'): boolean {
    return this.gameState.units.some((u) => {
      if (u.faction !== defender) return false;
      if (!isUnitAlive(u)) return false;
      if (u.lockedThisInitiative) return false;
      if (u.cannotReactThisRound) return false;
      if (u.damage === 'SUPPRESSED') return false;
      return u.weapons.some(
        (w) => w.kind === 'SHOOT' && w.modes.includes('REACTION'),
      );
    });
  }

  /**
   * Centralised auto-skip decision. Returns true when the reaction phase
   * should be bypassed entirely because no defender can react. Each
   * `enter*ReactionPhase` calls this right after `this.reaction` is set up
   * and immediately invokes confirmReaction() if true, dispatching the
   * underlying command with an empty marker plan.
   */
  private autoSkipReactionIfNoReactor(): boolean {
    if (!this.reaction) return false;
    const defender: 'A' | 'B' =
      this.reaction.moverFaction === 'A' ? 'B' : 'A';
    if (this.defenderHasAnyEligibleReactor(defender)) return false;
    this.hud.pushInfo('⚡ 反應階段:無可反應單位 → 自動跳過');
    this.confirmReaction();
    return true;
  }

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

    const duration = Math.max(
      MOVEMENT_TWEEN_MIN_MS,
      (dist / UNIT_DISTANCE_PIXELS) * MOVEMENT_MS_PER_UD,
    );
    // Crawl flip: while a prone unit is sliding to a new position, toggle
    // the prone sprite's horizontal flip on a fixed cadence so the limbs
    // visibly alternate. Stops + resets on tween complete.
    const u = this.gameState.units.find((x) => x.id === unitId);
    const flip = u?.stance === 'PRONE' ? this.startCrawlFlip(unitId) : null;
    this.movementTweens++;
    const tween = this.tweens.add({
      targets: container,
      x: to.x,
      y: to.y,
      duration,
      ease: 'Sine.InOut',
      onComplete: () => {
        flip?.stop();
        this.movementTweens = Math.max(0, this.movementTweens - 1);
        this.activeMovesMeta.delete(unitId);
        if (endFacing !== null) this.setUnitFacing(unitId, endFacing);
        if (this.movementTweens === 0) this.maybeScheduleAiTick();
      },
    });
    this.activeMovesMeta.set(unitId, { from, to, windows, tween });
  }

  private startCrawlFlip(unitId: string): { stop: () => void } | null {
    const c = this.unitContainers.get(unitId);
    if (!c) return null;
    const prone = c.getByName('spriteProne') as
      | Phaser.GameObjects.Sprite
      | null;
    if (!prone) return null;
    const proneTint = c.getByName('spriteProneTint') as
      | Phaser.GameObjects.Sprite
      | null;
    let flipped = false;
    const ev = this.time.addEvent({
      delay: CRAWL_FLIP_INTERVAL_MS,
      loop: true,
      callback: () => {
        flipped = !flipped;
        prone.setFlipX(flipped);
        if (proneTint) proneTint.setFlipX(flipped);
      },
    });
    return {
      stop: () => {
        ev.remove();
        prone.setFlipX(false);
        if (proneTint) proneTint.setFlipX(false);
      },
    };
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

  /**
   * Center-screen banner shown whenever initiative changes hands. Renders as
   * a full-width semi-transparent black bar across the camera midline with
   * the side-label (and dramatic subtitle when relevant) on top. Anchored to
   * the camera viewport with high depth so it stays legible above the
   * battlefield. Quick in/out fade — total ~700ms.
   */
  private showTurnoverBanner(
    to: 'A' | 'B',
    reason: TurnoverReason,
  ): void {
    const cam = this.cameras.main;
    const cx = cam.centerX;
    const cy = cam.centerY;
    const barHeight = 110;
    const colorHex = `#${FACTION_COLOR[to].toString(16).padStart(6, '0')}`;
    const mainLabel = to === 'A' ? '我方主動' : '敵方主動';
    const subtitleMap: Partial<Record<TurnoverReason, string>> = {
      REACTION_HIT: '反應命中',
      MELEE_LOSS: '近戰敗北',
      ACTION_FAILED: '行動失敗',
    };
    const subLabel = subtitleMap[reason];

    const bar = this.add.rectangle(cx, cy, cam.width, barHeight, 0x000000, 0.7);
    bar.setOrigin(0.5);
    bar.setScrollFactor(0);
    bar.setDepth(10000);
    bar.setAlpha(0);

    const mainY = subLabel ? cy - 16 : cy;
    const main = this.add.text(cx, mainY, mainLabel, {
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      fontSize: '52px',
      color: colorHex,
      fontStyle: 'bold',
    });
    main.setOrigin(0.5);
    main.setScrollFactor(0);
    main.setDepth(10001);
    main.setAlpha(0);

    const sub: Phaser.GameObjects.Text | null = subLabel
      ? this.add.text(cx, cy + 28, subLabel, {
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          fontSize: '22px',
          color: '#dddddd',
        })
      : null;
    if (sub) {
      sub.setOrigin(0.5);
      sub.setScrollFactor(0);
      sub.setDepth(10001);
      sub.setAlpha(0);
    }

    const targets: Phaser.GameObjects.GameObject[] = sub
      ? [bar, main, sub]
      : [bar, main];
    this.tweens.add({
      targets,
      alpha: 1,
      duration: 120,
      ease: 'Cubic.Out',
      onComplete: () => {
        this.tweens.add({
          targets,
          alpha: 0,
          duration: 180,
          delay: 400,
          ease: 'Cubic.In',
          onComplete: () => {
            bar.destroy();
            main.destroy();
            sub?.destroy();
          },
        });
      },
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
      noIntelActive: this.noIntelActive,
    };
    this.hud.update(this.gameState, this.selectedUnitId, this.aimMode, ctx);
    this.hud.setMissionInfo(this.formatMissionLabel());
    this.hud.setMissionProgress(
      formatScenarioProgress(
        this.gameState,
        this.missionScenario,
        this.missionParams,
        this.missionInitialAlive,
      ),
    );
    // Refresh detail card so a pinned unit's panel reflects damage / stance
    // / activation flags as combat unfolds.
    this.updateUnitDetailPanel();
  }

  /**
   * Build the top-of-HUD scenario tag — shows the win condition + any
   * scenario-specific countdown / count progress so the player can see at
   * a glance what they're racing toward. Time-based scenarios measure
   * their clock in 玩家活動數 (cumulative player activations).
   */
  private formatMissionLabel(): string | null {
    const acts = this.gameState.initiative.playerActivations;
    if (this.missionScenario === 'engage-reach') {
      return this.missionParams.requireAllObjectives
        ? '⚑ 攻佔全部目標'
        : '⚑ 攻佔目標';
    }
    if (this.missionScenario === 'control-points') {
      const scores =
        this.gameState.initiative.objectiveScores ?? { A: 0, B: 0 };
      const winScore = this.missionParams.winScore ?? 5;
      const winLead = this.missionParams.winLead ?? 2;
      return `⚑ 占領 A:${scores.A} / B:${scores.B}（目標 ${winScore}，領先 ${winLead}）`;
    }
    if (this.missionScenario === 'defend') {
      const goal = this.missionParams.defendActivations ?? 999;
      if (goal >= 999) return '⚑ 守住目標';
      return `⚑ 守住目標 ${Math.min(acts, goal)}/${goal} 活動`;
    }
    if (this.missionScenario === 'extract') {
      const need = this.missionParams.extractCount ?? 2;
      const limit = this.missionParams.extractActivations ?? 999;
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
      if (limit >= 999) return `⚑ 撤離 ${onObj}/${need}`;
      return `⚑ 撤離 ${onObj}/${need}・剩 ${Math.max(0, limit - acts)} 活動`;
    }
    if (this.missionScenario === 'assassinate') {
      const limit = this.missionParams.assassinateActivations ?? 999;
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
      if (limit >= 999) return `⚑ 斬首目標 ${status}`;
      return `⚑ 斬首目標 ${status}・剩 ${Math.max(0, limit - acts)} 活動`;
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
    const officerEnd =
      officerTarget && pcm
        ? this.resolveCommandMoveEndpoint(
            officer,
            officerTarget,
            pcm.officerStance ?? 'STANDING',
          )
        : undefined;
    const participants: import('../ui/Hud').CommandMoveParticipant[] = nearby.map(
      (u) => {
        const slot = pcm?.participants.get(u.id);
        const target = slot?.target ?? null;
        const targetValid =
          !!target &&
          !!officerEnd &&
          v2Dist(target, officerEnd) <= UNIT_DISTANCE_PIXELS + 0.5;
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
      canEndProne: !inDifficult && !unitHasTrait(u, 'NO_PRONE'),
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
    const noVault = unitHasTrait(u, 'NO_VAULT');
    const noClimb = unitHasTrait(u, 'NO_CLIMB');
    const wall = this.findContactedHardWallForUnit(u);
    const softTerrain = findContactedSoftTerrain(this.gameState.terrain, u);
    const canTraverse = softTerrain !== null;
    const door = findContactedDoor(this.gameState.terrain, u);
    const canOperateDoor = !!door && unitHasTrait(u, 'DOOR_OPERATOR');
    const doorIsOpen = door?.isOpen ?? false;
    const canPassDoor = !!door && doorIsOpen;
    const doorContext = { canOperateDoor, doorIsOpen, canPassDoor };
    if (!wall) return { canVault: false, canClimb: false, canTraverse, ...doorContext };
    if (
      wall.kind === 'BLOCKER' ||
      wall.kind === 'OUT_OF_BOUNDS' ||
      wall.kind === 'NO_ENTRY'
    ) {
      return { canVault: false, canClimb: false, canTraverse, ...doorContext };
    }
    if (wall.kind === 'HIGH_GROUND') {
      return { canVault: false, canClimb: !noClimb, canTraverse, ...doorContext };
    }
    const isLow =
      wall.height !== undefined && wall.height <= UNIT_DISTANCE_PIXELS;
    return {
      canVault: isLow && !noVault,
      canClimb: !isLow && !noClimb,
      canTraverse,
      ...doorContext,
    };
  }

  private findContactedHardWallForUnit(
    u: Unit,
  ): import('../../core/state/GameState').Terrain | null {
    return findContactedWall(this.gameState.terrain, u);
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
        // NO_PRONE units can't crawl → skip the stance picker, go straight
        // to the standing-move aim. Saves a meaningless click.
        const u = this.gameState.units.find((x) => x.id === act.unitId);
        if (u && unitHasTrait(u, 'NO_PRONE')) {
          this.pendingMoveStance = 'STANDING';
          this.pendingEndProne = false;
          this.aimMode = 'aim-move';
          this.refreshHud();
          this.startTimer('Move target', timersConfig.moveTargetSeconds, () =>
            this.cancelAim(),
          );
          return;
        }
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
      case 'REQUEST_TRAVERSE': {
        const act = this.gameState.initiative.activeActivation;
        if (!act) return;
        this.enterTraverseReactionPhase();
        return;
      }
      case 'REQUEST_OPERATE_DOOR': {
        const act = this.gameState.initiative.activeActivation;
        if (!act) return;
        const u = this.gameState.units.find((x) => x.id === act.unitId);
        if (!u) return;
        const door = findContactedDoor(this.gameState.terrain, u);
        if (!door) return;
        this.dispatch({ type: 'OPERATE_DOOR', unitId: act.unitId, terrainId: door.id });
        return;
      }
      case 'REQUEST_PASS_DOOR': {
        const act = this.gameState.initiative.activeActivation;
        if (!act) return;
        this.enterVaultClimbReactionPhase('PASS_DOOR');
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
        // NO_PRONE officer skips the stance picker (CRAWL unavailable).
        if (unitHasTrait(officer, 'NO_PRONE')) {
          this.aimMode = 'aim-command-move-officer';
        } else {
          this.aimMode = 'aim-command-move-officer-stance';
        }
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
      case 'TRAVERSE':
        this.dispatch({
          type: 'TRAVERSE',
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
      case 'PASS_DOOR':
        this.dispatch({
          type: 'PASS_DOOR',
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

  private hideTerrainTooltip(): void {
    this.terrainTooltipEl?.classList.remove('visible');
  }

  private updateTerrainTooltip(wp: { x: number; y: number }, screenX: number, screenY: number): void {
    const el = this.terrainTooltipEl;
    if (!el) return;
    const hit = this.gameState.terrain.find(
      (t) =>
        (t.briefHint || t.detailHint || t.displayName) &&
        isPointInPolygon(wp, t.polygon),
    );
    if (!hit) {
      el.classList.remove('visible');
      return;
    }
    const name = hit.displayName ?? '';
    const hint = this.terrainTooltipAlt
      ? (hit.detailHint ?? hit.briefHint ?? '')
      : (hit.briefHint ?? '');
    const altLabel = !this.terrainTooltipAlt && hit.detailHint
      ? '按住 Alt 查看詳細說明'
      : '';
    el.innerHTML =
      (name ? `<div class="tt-name">${name}</div>` : '') +
      (hint ? `<div class="tt-hint">${hint}</div>` : '') +
      (altLabel ? `<div class="tt-alt-label">${altLabel}</div>` : '');
    // Position tooltip 14px right + 14px below cursor, flip left if near right edge.
    const pad = 14;
    const vw = window.innerWidth;
    const right = screenX + pad + 260 > vw;
    el.style.left = right ? `${screenX - 260 - pad}px` : `${screenX + pad}px`;
    el.style.top = `${screenY + pad}px`;
    el.classList.add('visible');
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.panDrag) {
      const cam = this.cameras.main;
      cam.scrollX = this.panDrag.scrollX + (this.panDrag.x - pointer.x) / cam.zoom;
      cam.scrollY = this.panDrag.scrollY + (this.panDrag.y - pointer.y) / cam.zoom;
      this.hideTerrainTooltip();
      return;
    }
    const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.updateTerrainTooltip(wp, pointer.x, pointer.y);
    // LOS preview overlay: only when idle (not aiming / not in reaction
    // phase). Showing during aim modes would add visual noise on top of
    // the aim cursor + move-preview lines.
    if (this.aimMode === 'idle') {
      const hovered = this.findUnitAtPointer(pointer);
      if (hovered !== this.losPreviewUnitId) {
        this.losPreviewUnitId = hovered;
        this.renderLosOverlay(hovered);
        this.updateUnitDetailPanel();
      }
    } else if (this.losPreviewUnitId !== null) {
      this.losPreviewUnitId = null;
      this.renderLosOverlay(null);
      this.updateUnitDetailPanel();
    }
    if (this.aimMode === 'aim-command-move-officer') {
      this.updateMovePreview({ x: wp.x, y: wp.y });
      return;
    }
    if (this.aimMode === 'aim-command-move-participant') {
      this.drawCommandMoveOverlay();
      this.drawCommandMoveCursorPreview({ x: wp.x, y: wp.y });
      return;
    }
    if (this.aimMode !== 'aim-move') return;
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
      const pcm = this.pendingCommandMove;
      const officerTarget = pcm.officerTarget;
      if (!officerTarget) return;
      const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      const act = this.gameState.initiative.activeActivation;
      const officer = act
        ? this.gameState.units.find((u) => u.id === act.unitId)
        : undefined;
      const officerEnd = officer
        ? this.resolveCommandMoveEndpoint(
            officer,
            officerTarget,
            pcm.officerStance ?? 'STANDING',
          )
        : officerTarget;
      // Reject clicks > 1 UD from officer's resolved endpoint (matches
      // reducer validation in commandMoveAction).
      if (
        v2Dist({ x: wp.x, y: wp.y }, officerEnd) >
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
    const enterStopPolygons = movementEnterStopPolygons(this.gameState.terrain);
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
    if (this.autoSkipReactionIfNoReactor()) return;
    this.startTimer(
      'Reaction',
      timersConfig.reactionPhaseSeconds,
      () => this.confirmReaction(),
    );
    this.maybeScheduleAiTick();
  }

  private enterTraverseReactionPhase(): void {
    const act = this.gameState.initiative.activeActivation;
    if (!act) return;
    const u = this.gameState.units.find((x) => x.id === act.unitId);
    if (!u) return;
    const terrain = findContactedSoftTerrain(this.gameState.terrain, u);
    if (!terrain) {
      this.hud.pushError(`${u.id} not touching a terrain edge`);
      return;
    }
    const dest = traverseDestination(u, terrain.polygon);

    const enemies = this.gameState.units
      .filter((o) => o.faction !== u.faction && isUnitAlive(o))
      .map((o) => ({
        id: o.id,
        circle: getUnitCircle(o),
        prone: o.stance === 'PRONE',
      }));
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
      commandType: 'TRAVERSE',
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
    if (this.autoSkipReactionIfNoReactor()) return;
    this.startTimer(
      'Reaction',
      timersConfig.reactionPhaseSeconds,
      () => this.confirmReaction(),
    );
    this.maybeScheduleAiTick();
  }

  private enterVaultClimbReactionPhase(commandType: 'VAULT' | 'CLIMB' | 'PASS_DOOR'): void {
    const act = this.gameState.initiative.activeActivation;
    if (!act) return;
    const u = this.gameState.units.find((x) => x.id === act.unitId);
    if (!u) return;
    let dest: import('../../core/geometry/types').Vec2;
    if (commandType === 'PASS_DOOR') {
      const door = findContactedDoor(this.gameState.terrain, u);
      if (!door) {
        this.hud.pushError(`${u.id} not touching a door`);
        return;
      }
      dest = vaultDestination(u, door.polygon.vertices);
    } else {
      const wall = this.findContactedHardWallForUnit(u);
      if (!wall) {
        this.hud.pushError(`${u.id} not touching a wall`);
        return;
      }
      dest =
        commandType === 'VAULT'
          ? vaultDestination(u, wall.polygon.vertices)
          : wall.kind === 'HIGH_GROUND'
            ? traverseDestination(u, wall.polygon)
            : climbDestination(u, wall.polygon.vertices);
    }

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
    if (this.autoSkipReactionIfNoReactor()) return;
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
    const enterStopPolygons = movementEnterStopPolygons(this.gameState.terrain);
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
    if (this.autoSkipReactionIfNoReactor()) return;
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
    if (this.autoSkipReactionIfNoReactor()) return;
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
    if (this.autoSkipReactionIfNoReactor()) return;
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

  /**
   * Mirror of the reducer's command-move endpoint resolution: applies stance
   * cap, then runs computeMovePath against terrain + non-mover units + peer
   * movers' desired ends. The visual placement of each command-move circle
   * needs this so the previewed position matches where the unit will
   * actually stop, not the raw click point that may sit inside a wall.
   *
   * Excludes `mover.id` from friendly obstacles so the unit doesn't collide
   * with itself; treats every other officer/participant's target (or
   * current position if they have no target yet) as an obstacle, just like
   * the reducer does at line 1352-1370.
   */
  private resolveCommandMoveEndpoint(
    mover: Unit,
    desiredTarget: Vec2,
    stance: 'STANDING' | 'CRAWL',
  ): Vec2 {
    // Stance cap (same logic as updateMovePreview / capForStance).
    let target = desiredTarget;
    if (stance === 'CRAWL') {
      const dx = target.x - mover.position.x;
      const dy = target.y - mover.position.y;
      const len = Math.hypot(dx, dy);
      if (len > UNIT_DISTANCE_PIXELS) {
        target = {
          x: mover.position.x + (dx / len) * UNIT_DISTANCE_PIXELS,
          y: mover.position.y + (dy / len) * UNIT_DISTANCE_PIXELS,
        };
      }
    }

    const pcm = this.pendingCommandMove;
    const moverIds = new Set<string>();
    if (pcm) {
      const act = this.gameState.initiative.activeActivation;
      if (act) moverIds.add(act.unitId);
      for (const [id, slot] of pcm.participants) {
        if (slot.included) moverIds.add(id);
      }
    }

    // Other movers' desired endpoints (cap-stance applied) become obstacles.
    const peerEndCircles: Array<{ center: Vec2; radius: number }> = [];
    if (pcm) {
      const act = this.gameState.initiative.activeActivation;
      const officer = act
        ? this.gameState.units.find((x) => x.id === act.unitId)
        : null;
      if (officer && officer.id !== mover.id && pcm.officerTarget) {
        // Use officer's *resolved* endpoint (collision-aware) so participants
        // dodge around the actual stopping point — matches reducer's
        // sequential resolution. Officer comes first, so resolving here
        // doesn't recurse into participant logic.
        const officerEnd = this.resolveCommandMoveEndpoint(
          officer,
          pcm.officerTarget,
          pcm.officerStance ?? 'STANDING',
        );
        peerEndCircles.push({ center: officerEnd, radius: officer.radius });
      }
      for (const [pid, slot] of pcm.participants) {
        if (pid === mover.id) continue;
        if (!slot.included || !slot.target) continue;
        const pu = this.gameState.units.find((x) => x.id === pid);
        if (!pu) continue;
        const cap =
          slot.stance === 'CRAWL'
            ? this.capCrawlTarget(pu.position, slot.target)
            : slot.target;
        peerEndCircles.push({ center: cap, radius: pu.radius });
      }
    }

    const stoppingPolygons = movementBlockingPolygons(
      this.gameState.terrain,
      mover.position,
    );
    const enterStopPolygons = movementEnterStopPolygons(this.gameState.terrain);
    const exitStopPolygons = movementExitStopPolygons(
      this.gameState.terrain,
      mover.position,
    );
    const enemyCircles = this.gameState.units
      .filter((o) => o.faction !== mover.faction && isUnitAlive(o))
      .map(getUnitCircle);
    const friendlyCircles = [
      ...this.gameState.units
        .filter(
          (o) =>
            o.faction === mover.faction &&
            !moverIds.has(o.id) &&
            isUnitAlive(o),
        )
        .map(getUnitCircle),
      ...peerEndCircles,
    ];
    const path = computeMovePath(mover.position, target, {
      polygons: stoppingPolygons,
      enterStopPolygons,
      exitStopPolygons,
      enemyCircles,
      friendlyCircles,
      moverRadius: mover.radius,
    });
    return path.endpoint;
  }

  private capCrawlTarget(from: Vec2, target: Vec2): Vec2 {
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len <= UNIT_DISTANCE_PIXELS) return target;
    return {
      x: from.x + (dx / len) * UNIT_DISTANCE_PIXELS,
      y: from.y + (dy / len) * UNIT_DISTANCE_PIXELS,
    };
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

    // Officer's resolved endpoint (collision-aware). Validity ring centers
    // here too — reducer validates participant targets against this point,
    // so the visual reach must match.
    const officerEnd = this.resolveCommandMoveEndpoint(
      officer,
      pcm.officerTarget,
      pcm.officerStance ?? 'STANDING',
    );
    this.aimGfx.lineStyle(1.5, FACTION_COLOR[officer.faction], 0.9);
    this.aimGfx.beginPath();
    this.aimGfx.moveTo(officer.position.x, officer.position.y);
    this.aimGfx.lineTo(officerEnd.x, officerEnd.y);
    this.aimGfx.strokePath();
    this.aimGfx.fillStyle(FACTION_COLOR[officer.faction], 0.35);
    this.aimGfx.fillCircle(officerEnd.x, officerEnd.y, officer.radius);

    this.aimGfx.lineStyle(1.5, 0x9af09a, 0.85);
    this.aimGfx.strokeCircle(officerEnd.x, officerEnd.y, UNIT_DISTANCE_PIXELS);

    // Each participant's planned target → resolved to a collision-aware
    // endpoint for the rendered circle.
    for (const [id, slot] of pcm.participants) {
      const u = this.gameState.units.find((x) => x.id === id);
      if (!u || !slot.target) continue;
      const valid = v2Dist(slot.target, officerEnd) <= UNIT_DISTANCE_PIXELS + 0.5;
      const color = valid ? FACTION_COLOR[u.faction] : 0xff5555;
      const end = this.resolveCommandMoveEndpoint(u, slot.target, slot.stance);
      this.aimGfx.lineStyle(1.5, color, slot.included ? 0.85 : 0.35);
      this.aimGfx.beginPath();
      this.aimGfx.moveTo(u.position.x, u.position.y);
      this.aimGfx.lineTo(end.x, end.y);
      this.aimGfx.strokePath();
      this.aimGfx.fillStyle(color, slot.included ? 0.35 : 0.15);
      this.aimGfx.fillCircle(end.x, end.y, u.radius);
    }
  }

  private drawCommandMoveCursorPreview(cursor: Vec2): void {
    if (!this.pendingCommandMove) return;
    const pcm = this.pendingCommandMove;
    if (!pcm.officerTarget || !this.cmdMoveAimUnitId) return;
    const u = this.gameState.units.find((x) => x.id === this.cmdMoveAimUnitId);
    if (!u) return;
    const slot = pcm.participants.get(this.cmdMoveAimUnitId);
    const stance = slot?.stance ?? 'STANDING';
    const act = this.gameState.initiative.activeActivation;
    const officer = act
      ? this.gameState.units.find((x) => x.id === act.unitId)
      : undefined;
    const officerEnd = officer
      ? this.resolveCommandMoveEndpoint(
          officer,
          pcm.officerTarget,
          pcm.officerStance ?? 'STANDING',
        )
      : pcm.officerTarget;
    const valid = v2Dist(cursor, officerEnd) <= UNIT_DISTANCE_PIXELS + 0.5;
    const color = valid ? 0x9af09a : 0xff5555;
    const end = this.resolveCommandMoveEndpoint(u, cursor, stance);
    this.aimGfx.lineStyle(2, color, 0.95);
    this.aimGfx.fillStyle(color, 0.25);
    this.aimGfx.fillCircle(end.x, end.y, u.radius);
    this.aimGfx.strokeCircle(end.x, end.y, u.radius);
    this.aimGfx.beginPath();
    this.aimGfx.moveTo(u.position.x, u.position.y);
    this.aimGfx.lineTo(end.x, end.y);
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
  const glow = document.getElementById('hud-frame-glow');
  if (glow) (glow as HTMLElement).style.display = '';
};
