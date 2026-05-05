import Phaser from 'phaser';
import { buildUnit, getMap, getMissionDef, listUnitTemplates } from '../../config/loader';
import { drawTerrain, polygonCentroid } from '../rendering/terrain';
import { paintBoardFloorPhaser } from '../rendering/boardFloor';
import type { Vec2 } from '../../core/geometry/types';
import { v2 } from '../../core/geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../../core/rules/constants';
import { buildInitialState } from '../../core/setup/buildState';
import { pointInPolygon } from '../../core/setup/geometry';
import type {
  DeploymentPlacement,
  DeploymentZone,
  MapDef,
  RostersBySide,
} from '../../core/setup/types';
import type { Faction } from '../../core/state/GameState';
import { DEFAULT_MAP_ID } from '../state/setupBattleState';
import {
  currentMissionDeploymentSlotsActive,
  type RunState,
} from '../../runs/state';

/**
 * DeployScene operates in two modes:
 *
 *  - **VS mode** (default, legacy): both factions place their squads
 *    alternately, then we hand `buildInitialState`'s GameState to BattleScene.
 *
 *  - **Campaign mode**: caller passes `runState`. Only the player (faction A)
 *    deploys; AI enemies are spawned at the mission's authored
 *    `enemies[].position`. We hand `{ runState, manualPlayerDeployment }`
 *    to BattleScene which routes through `buildMissionState`.
 *
 * Multi-zone faction-A maps are supported in both modes — `canPlaceAt` checks
 * against the union of Zone-A polygons. Multi-zone faction-B is intentionally
 * not exposed (campaign maps don't deploy AI; sandbox VS maps haven't
 * historically had multi-B layouts).
 *
 * Slot enforcement (when active in campaign mode): the first
 * min(squadSize, slotCount) Zone-A slots must each receive ≥1 unit. The
 * Start button stays disabled until both this constraint and "all squad
 * deployed" hold.
 */

interface VsInitData {
  rosters: RostersBySide;
  firstHolder: Faction;
  deployFirst: Faction;
  mapId?: string;
  runState?: undefined;
}

interface CampaignInitData {
  runState: RunState;
}

type InitData = VsInitData | CampaignInitData;

const FACTION_COLOR: Readonly<Record<Faction, number>> = {
  A: 0x4a8acf,
  B: 0xcf5a4a,
};

const ZONE_FILL: Readonly<Record<Faction, number>> = {
  A: 0x4a8acf,
  B: 0xcf5a4a,
};


export class DeployScene extends Phaser.Scene {
  private rosters!: RostersBySide;
  private firstHolder!: Faction;
  private deployFirst!: Faction;
  private mapId: string = DEFAULT_MAP_ID;
  private map!: MapDef;
  private placements: { A: DeploymentPlacement[]; B: DeploymentPlacement[] } = {
    A: [],
    B: [],
  };
  /** Faction currently deploying; null when both done. */
  private currentSide: Faction | null = null;
  private rootEl!: HTMLElement;
  private terrainGfx!: Phaser.GameObjects.Graphics;
  private terrainLabels: Phaser.GameObjects.Text[] = [];
  private zoneLabels: Phaser.GameObjects.Text[] = [];
  private boardEdgeGfx!: Phaser.GameObjects.Graphics;
  private zonesGfx!: Phaser.GameObjects.Graphics;
  private placementsGfx!: Phaser.GameObjects.Graphics;
  private hoverGfx!: Phaser.GameObjects.Graphics;

  // Campaign-mode fields
  private runState: RunState | null = null;
  /** True when the active mission demands strict slot occupancy. */
  private slotsEnforced = false;

  constructor() {
    super({ key: 'Deploy' });
  }

  init(data: InitData): void {
    if ('runState' in data && data.runState) {
      this.runState = data.runState;
      const idx = data.runState.missionIndex;
      const mid = data.runState.missionIds[idx];
      // Fall back to demo if route's gone off the rails — defensive.
      if (!mid) throw new Error('DeployScene: runState has no current mission');
      const mission = getMissionDef(mid);
      this.mapId = mission.mapId;
      // In campaign mode the player-only roster is the live squad
      // (survivors of prior stages).
      const aliveSet = new Set(data.runState.survivorIds);
      const liveSquad = data.runState.squad.filter((s) => aliveSet.has(s.id));
      this.rosters = { A: liveSquad, B: [] };
      this.firstHolder = 'A';
      this.deployFirst = 'A';
      this.slotsEnforced = currentMissionDeploymentSlotsActive(
        data.runState,
        mission,
      );
    } else {
      const vs = data as VsInitData;
      this.runState = null;
      this.rosters = vs.rosters;
      this.firstHolder = vs.firstHolder;
      this.deployFirst = vs.deployFirst;
      this.mapId = vs.mapId ?? DEFAULT_MAP_ID;
      this.slotsEnforced = false;
    }
  }

  create(): void {
    // Reset per scene entry (Phaser reuses scene instances).
    this.placements = { A: [], B: [] };
    this.currentSide = null;
    this.terrainLabels = [];
    this.zoneLabels = [];
    this.map = getMap(this.mapId);
    this.cameras.main.setBackgroundColor('#0a0c0a');
    this.boardEdgeGfx = this.add.graphics();
    this.zonesGfx = this.add.graphics();
    this.terrainGfx = this.add.graphics();
    this.placementsGfx = this.add.graphics();
    this.hoverGfx = this.add.graphics();
    this.fitCamera();
    const resizeHandler = () => this.fitCamera();
    this.scale.on('resize', resizeHandler);
    this.events.once('shutdown', () => this.scale.off('resize', resizeHandler));

    this.rootEl = this.makeRoot();
    this.events.once('shutdown', () => this.rootEl?.remove());
    this.currentSide = this.deployFirst;
    this.refresh();

    this.input.on('pointermove', this.onPointerMove, this);
    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.keyboard?.on('keydown-Z', () => this.undo());
  }

  private fitCamera(): void {
    const cam = this.cameras.main;
    const margin = 0.85;
    const zoom =
      Math.min(cam.width / this.map.size, cam.height / this.map.size) * margin;
    cam.setZoom(zoom);
    cam.centerOn(this.map.size / 2, this.map.size / 2);
    this.boardEdgeGfx.clear();
    paintBoardFloorPhaser(this.boardEdgeGfx, this.map.size);
    this.boardEdgeGfx.lineStyle(2, 0x2a3a2a);
    this.boardEdgeGfx.strokeRect(0, 0, this.map.size, this.map.size);
    this.renderTerrain();
    this.renderZones();
    this.renderPlacements();
  }

  private renderTerrain(): void {
    this.terrainGfx.clear();
    for (const lbl of this.terrainLabels) lbl.destroy();
    this.terrainLabels = [];
    for (const t of this.map.terrain) {
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

  private zoneOccupancyCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const z of this.map.deploymentZones) counts.set(z.id, 0);
    for (const p of this.placements.A) {
      for (const z of this.map.deploymentZones) {
        if (z.faction === 'A' && pointInPolygon(p.position, z.polygon)) {
          counts.set(z.id, (counts.get(z.id) ?? 0) + 1);
          break;
        }
      }
    }
    return counts;
  }

  private requiredZoneACount(): number {
    if (!this.slotsEnforced) return 0;
    const slotCount = this.map.deploymentZones.filter(
      (z) => z.faction === 'A' && typeof z.slotIndex === 'number',
    ).length;
    return Math.min(this.rosters.A.length, slotCount);
  }

  private renderZones(): void {
    this.zonesGfx.clear();
    for (const lbl of this.zoneLabels) lbl.destroy();
    this.zoneLabels = [];
    const counts = this.zoneOccupancyCounts();
    const reqCount = this.requiredZoneACount();
    for (const z of this.map.deploymentZones) {
      const isActive = z.faction === this.currentSide;
      this.zonesGfx.fillStyle(ZONE_FILL[z.faction], isActive ? 0.18 : 0.08);
      this.zonesGfx.lineStyle(2, ZONE_FILL[z.faction], isActive ? 0.9 : 0.4);
      const verts = z.polygon.vertices;
      this.zonesGfx.beginPath();
      this.zonesGfx.moveTo(verts[0]!.x, verts[0]!.y);
      for (let i = 1; i < verts.length; i++)
        this.zonesGfx.lineTo(verts[i]!.x, verts[i]!.y);
      this.zonesGfx.closePath();
      this.zonesGfx.fillPath();
      this.zonesGfx.strokePath();
      // Slot-number badge for Zone-A. Show even when enforcement is off
      // so the designer can see the layout's intent; tint the required
      // slots when enforcement is on and they're empty (warning red).
      if (z.faction === 'A' && typeof z.slotIndex === 'number') {
        const c = polygonCentroid(verts);
        const occ = counts.get(z.id) ?? 0;
        const required = z.slotIndex <= reqCount;
        const empty = occ === 0;
        const tint =
          required && empty ? '#ff8a6a' : occ > 0 ? '#9af09a' : '#9aa89a';
        const badge = this.add.text(
          c.x,
          c.y,
          `#${z.slotIndex}${occ > 0 ? ` · ${occ}` : ''}`,
          {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '11px',
            color: tint,
            fontStyle: 'bold',
          },
        );
        badge.setOrigin(0.5);
        this.zoneLabels.push(badge);
      }
    }
  }

  private renderPlacements(): void {
    this.placementsGfx.clear();
    for (const f of ['A', 'B'] as const) {
      for (const p of this.placements[f]) {
        this.placementsGfx.fillStyle(FACTION_COLOR[f], 1);
        this.placementsGfx.lineStyle(1.5, 0xffffff, 1);
        this.placementsGfx.fillCircle(
          p.position.x,
          p.position.y,
          STANDARD_BASE_RADIUS_PIXELS,
        );
        this.placementsGfx.strokeCircle(
          p.position.x,
          p.position.y,
          STANDARD_BASE_RADIUS_PIXELS,
        );
      }
    }
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    this.hoverGfx.clear();
    if (!this.currentSide) return;
    const next = this.nextRosterEntry(this.currentSide);
    if (!next) return;
    const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const pos = { x: wp.x, y: wp.y };
    const ok = this.canPlaceAt(pos, this.currentSide);
    const color = ok ? 0x9af09a : 0xff5555;
    this.hoverGfx.lineStyle(2, color, 0.9);
    this.hoverGfx.fillStyle(FACTION_COLOR[this.currentSide], ok ? 0.4 : 0.15);
    this.hoverGfx.fillCircle(pos.x, pos.y, STANDARD_BASE_RADIUS_PIXELS);
    this.hoverGfx.strokeCircle(pos.x, pos.y, STANDARD_BASE_RADIUS_PIXELS);
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    if (!this.currentSide) return;
    const next = this.nextRosterEntry(this.currentSide);
    if (!next) return;
    const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const pos = v2(wp.x, wp.y);
    if (!this.canPlaceAt(pos, this.currentSide)) return;
    this.placements[this.currentSide] = [
      ...this.placements[this.currentSide],
      { rosterId: next.id, position: pos },
    ];
    this.advanceTurn();
    this.renderPlacements();
    this.renderZones();
    this.refresh();
  }

  /**
   * Campaign mode: only A deploys, so we just stay until A is done.
   * VS mode: alternate sides; if one side is fully deployed, the other
   * finishes.
   */
  private advanceTurn(): void {
    if (this.runState) {
      // Player-only flow.
      const aRemaining = this.rosters.A.length - this.placements.A.length;
      this.currentSide = aRemaining > 0 ? 'A' : null;
      return;
    }
    const otherSide: Faction = this.currentSide === 'A' ? 'B' : 'A';
    const otherRemaining =
      this.rosters[otherSide].length - this.placements[otherSide].length;
    const selfRemaining =
      this.rosters[this.currentSide!].length -
      this.placements[this.currentSide!].length;
    if (otherRemaining > 0 && selfRemaining > 0) {
      this.currentSide = otherSide;
    } else if (otherRemaining > 0) {
      this.currentSide = otherSide;
    } else if (selfRemaining > 0) {
      // stay
    } else {
      this.currentSide = null;
    }
  }

  private undo(): void {
    if (this.runState) {
      // Campaign mode: only A has placements; pop the last one.
      if (this.placements.A.length === 0) return;
      this.placements.A = this.placements.A.slice(0, -1);
      this.currentSide = 'A';
      this.renderPlacements();
      this.renderZones();
      this.refresh();
      return;
    }
    if (!this.currentSide && this.placements.A.length === 0 && this.placements.B.length === 0) return;
    // Pop the most recent placement across both sides; resume that side.
    const lastSide: Faction =
      this.placements.A.length === 0 ||
      (this.placements.B.length > 0 &&
        this.placements.B.length >= this.placements.A.length)
        ? 'B'
        : 'A';
    if (this.placements[lastSide].length === 0) return;
    this.placements[lastSide] = this.placements[lastSide].slice(0, -1);
    this.currentSide = lastSide;
    this.renderPlacements();
    this.renderZones();
    this.refresh();
  }

  private nextRosterEntry(faction: Faction) {
    const placed = new Set(
      this.placements[faction].map((p) => p.rosterId),
    );
    return this.rosters[faction].find((r) => !placed.has(r.id));
  }

  private zonesForFaction(faction: Faction): DeploymentZone[] {
    return this.map.deploymentZones.filter((z) => z.faction === faction);
  }

  private canPlaceAt(pos: Vec2, faction: Faction): boolean {
    const zones = this.zonesForFaction(faction);
    if (zones.length === 0) return false;
    // Multi-zone: pos must fit fully inside *any* of the zones.
    const insideAny = zones.some((z) =>
      this.circleInsidePolygon(pos, STANDARD_BASE_RADIUS_PIXELS, z.polygon),
    );
    if (!insideAny) return false;
    // Don't overlap existing units.
    for (const f of ['A', 'B'] as const) {
      for (const p of this.placements[f]) {
        const dx = p.position.x - pos.x;
        const dy = p.position.y - pos.y;
        if (Math.hypot(dx, dy) < STANDARD_BASE_RADIUS_PIXELS * 2 + 4) {
          return false;
        }
      }
    }
    // Don't overlap hard cover (simple AABB check via polygon containment).
    for (const t of this.map.terrain) {
      if (this.circleHitsPolygon(pos, STANDARD_BASE_RADIUS_PIXELS, t.polygon)) {
        return false;
      }
    }
    return true;
  }

  private circleHitsPolygon(
    c: Vec2,
    r: number,
    poly: { vertices: ReadonlyArray<Vec2> },
  ): boolean {
    if (pointInPolygon(c, poly as { vertices: ReadonlyArray<Vec2> })) return true;
    const v = poly.vertices;
    for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
      const ax = v[j]!.x;
      const ay = v[j]!.y;
      const bx = v[i]!.x;
      const by = v[i]!.y;
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(
        0,
        Math.min(1, ((c.x - ax) * dx + (c.y - ay) * dy) / (dx * dx + dy * dy)),
      );
      const px = ax + dx * t - c.x;
      const py = ay + dy * t - c.y;
      if (Math.hypot(px, py) < r) return true;
    }
    return false;
  }

  // 圓是否完全在多邊形內：圓心在內 + 圓心到每條邊的最短距離 >= r。
  private circleInsidePolygon(
    c: Vec2,
    r: number,
    poly: { vertices: ReadonlyArray<Vec2> },
  ): boolean {
    if (!pointInPolygon(c, poly)) return false;
    const v = poly.vertices;
    for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
      const ax = v[j]!.x;
      const ay = v[j]!.y;
      const bx = v[i]!.x;
      const by = v[i]!.y;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((c.x - ax) * dx + (c.y - ay) * dy) / len2));
      const px = ax + dx * t - c.x;
      const py = ay + dy * t - c.y;
      if (Math.hypot(px, py) < r) return false;
    }
    return true;
  }

  private slotsConstraintSatisfied(): { ok: boolean; reason: string } {
    if (!this.slotsEnforced) return { ok: true, reason: '' };
    const counts = this.zoneOccupancyCounts();
    const required = this.requiredZoneACount();
    const missing: number[] = [];
    for (const z of this.map.deploymentZones) {
      if (z.faction !== 'A' || typeof z.slotIndex !== 'number') continue;
      if (z.slotIndex <= required && (counts.get(z.id) ?? 0) === 0) {
        missing.push(z.slotIndex);
      }
    }
    if (missing.length === 0) return { ok: true, reason: '' };
    return {
      ok: false,
      reason: `部署位 ${missing.join(', ')} 必須各有至少一人`,
    };
  }

  private makeRoot(): HTMLElement {
    const root = document.createElement('div');
    root.style.position = 'absolute';
    root.style.top = '0';
    root.style.left = '0';
    root.style.right = '0';
    root.style.padding = '8px 16px';
    root.style.background = 'rgba(10, 14, 10, 0.85)';
    root.style.borderBottom = '1px solid #2a3a2a';
    root.style.zIndex = '20';
    root.style.display = 'flex';
    root.style.gap = '14px';
    root.style.alignItems = 'center';
    root.style.color = '#cfe8cf';
    root.style.fontSize = '13px';
    root.innerHTML = `
      <strong>Deploy</strong>
      <span data-status></span>
      <span data-warn style="color:#ff8a6a;font-size:11px;"></span>
      <span style="margin-left:auto;font-size:11px;color:#7a9a7a;">Z = undo · click in highlighted zone to place</span>
      <button data-action="undo" style="padding:4px 10px;background:#1a2a1a;color:#cfe8cf;border:1px solid #3a5a3a;cursor:pointer;font:inherit;">Undo</button>
      <button data-action="continue" disabled style="padding:4px 14px;background:#1a2a1a;color:#cfe8cf;border:1px solid #3a5a3a;cursor:pointer;font:inherit;">Start Battle →</button>
    `;
    document.body.appendChild(root);
    root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.onclick =
      () => this.undo();
    root.querySelector<HTMLButtonElement>('[data-action="continue"]')!.onclick =
      () => this.startBattle();
    return root;
  }

  private refresh(): void {
    const status = this.rootEl.querySelector<HTMLElement>('[data-status]')!;
    const warn = this.rootEl.querySelector<HTMLElement>('[data-warn]')!;
    if (this.currentSide) {
      const next = this.nextRosterEntry(this.currentSide);
      const tplName = next
        ? listUnitTemplates().find((t) => t.templateId === next.templateId)
            ?.displayName ?? next.templateId
        : '?';
      const color = this.currentSide === 'A' ? '#6ab0ff' : '#ff8a6a';
      status.innerHTML = `<strong style="color:${color};">${this.currentSide}</strong> places <strong>${next?.id}</strong> (${tplName})`;
    } else {
      status.textContent = this.runState
        ? '隊伍已部署。按下 Start Battle 開戰。'
        : 'Both sides deployed. Press Start Battle.';
    }
    const slots = this.slotsConstraintSatisfied();
    warn.textContent = slots.ok ? '' : slots.reason;
    const cont =
      this.rootEl.querySelector<HTMLButtonElement>('[data-action="continue"]')!;
    cont.disabled = this.currentSide !== null || !slots.ok;
  }

  private startBattle(): void {
    if (this.currentSide !== null) return;
    if (!this.slotsConstraintSatisfied().ok) return;
    if (this.runState) {
      // Campaign hand-off — BattleScene routes through buildMissionState
      // with the placements we collected.
      const manualPlayerDeployment: DeploymentPlacement[] = [
        ...this.placements.A,
      ];
      this.rootEl.remove();
      this.scene.start('Battle', {
        runState: this.runState,
        manualPlayerDeployment,
      });
      return;
    }
    const initialState = buildInitialState({
      seed: `match-${Date.now()}`,
      map: this.map,
      rosters: this.rosters,
      deployment: {
        A: [...this.placements.A],
        B: [...this.placements.B],
      },
      firstHolder: this.firstHolder,
      buildUnit,
    });
    this.rootEl.remove();
    this.scene.start('Battle', { initialState });
  }
}
