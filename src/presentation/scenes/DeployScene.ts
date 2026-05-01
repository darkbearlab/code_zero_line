import Phaser from 'phaser';
import { buildUnit, getMap, listUnitTemplates } from '../../config/loader';
import { drawTerrain, polygonCentroid } from '../rendering/terrain';
import { paintBoardFloorPhaser } from '../rendering/boardFloor';
import type { Vec2 } from '../../core/geometry/types';
import { v2 } from '../../core/geometry/vec2';
import { STANDARD_BASE_RADIUS_PIXELS } from '../../core/rules/constants';
import { buildInitialState } from '../../core/setup/buildState';
import { pointInPolygon } from '../../core/setup/geometry';
import type {
  DeploymentPlacement,
  MapDef,
  RostersBySide,
} from '../../core/setup/types';
import type { Faction } from '../../core/state/GameState';
import { DEFAULT_MAP_ID } from '../state/setupBattleState';

interface InitData {
  rosters: RostersBySide;
  firstHolder: Faction;
  deployFirst: Faction;
  mapId?: string;
}

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
  private boardEdgeGfx!: Phaser.GameObjects.Graphics;
  private zonesGfx!: Phaser.GameObjects.Graphics;
  private placementsGfx!: Phaser.GameObjects.Graphics;
  private hoverGfx!: Phaser.GameObjects.Graphics;

  constructor() {
    super({ key: 'Deploy' });
  }

  init(data: InitData): void {
    this.rosters = data.rosters;
    this.firstHolder = data.firstHolder;
    this.deployFirst = data.deployFirst;
    this.mapId = data.mapId ?? DEFAULT_MAP_ID;
  }

  create(): void {
    // Reset per scene entry (Phaser reuses scene instances).
    this.placements = { A: [], B: [] };
    this.currentSide = null;
    this.terrainLabels = [];
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

  private renderZones(): void {
    this.zonesGfx.clear();
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

  /** Alternate sides; if one side is fully deployed, the other finishes. */
  private advanceTurn(): void {
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

  private canPlaceAt(pos: Vec2, faction: Faction): boolean {
    const zone = this.map.deploymentZones.find(
      (z) => z.faction === faction,
    );
    if (!zone) return false;
    if (!pointInPolygon(pos, zone.polygon)) return false;
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
    if (this.currentSide) {
      const next = this.nextRosterEntry(this.currentSide);
      const tplName = next
        ? listUnitTemplates().find((t) => t.templateId === next.templateId)
            ?.displayName ?? next.templateId
        : '?';
      const color = this.currentSide === 'A' ? '#6ab0ff' : '#ff8a6a';
      status.innerHTML = `<strong style="color:${color};">${this.currentSide}</strong> places <strong>${next?.id}</strong> (${tplName})`;
    } else {
      status.textContent = 'Both sides deployed. Press Start Battle.';
    }
    const cont =
      this.rootEl.querySelector<HTMLButtonElement>('[data-action="continue"]')!;
    cont.disabled = this.currentSide !== null;
  }

  private startBattle(): void {
    if (this.currentSide !== null) return;
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
