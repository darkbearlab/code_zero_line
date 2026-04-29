import type {
  Command,
  GameEvent,
  ReactionMarker,
  ShootMode,
} from '../../core/commands/types';
import type { GameState } from '../../core/state/GameState';

export type DispatchFn = (cmd: Command) => void;

export type AimMode =
  | 'idle'
  | 'aim-move-stance'
  | 'aim-move'
  | 'aim-shoot'
  | 'aim-melee'
  | 'aim-command-rally'
  | 'aim-command-move-officer-stance'
  | 'aim-command-move-officer'
  | 'aim-command-move-setup'
  | 'aim-command-move-participant'
  | 'reaction-phase';

export type ActionRequest =
  | 'REQUEST_MOVE'
  | 'REQUEST_RALLY'
  | 'REQUEST_SHOOT'
  | 'REQUEST_MELEE'
  | 'REQUEST_VAULT'
  | 'REQUEST_CLIMB'
  | 'REQUEST_COMMAND_RALLY'
  | 'REQUEST_COMMAND_MOVE'
  | 'CHOOSE_MOVE_STANDING'
  | 'CHOOSE_MOVE_CRAWL'
  | 'CHOOSE_CMD_MOVE_STANDING'
  | 'CHOOSE_CMD_MOVE_CRAWL'
  | 'TOGGLE_END_PRONE'
  | 'CONFIRM_COMMAND_RALLY'
  | 'CONFIRM_COMMAND_MOVE'
  | 'BACK_TO_CMD_MOVE_SETUP'
  | 'CANCEL_AIM'
  | 'CONFIRM_REACTION'
  | 'SKIP_REACTION'
  | 'SAVE_REPLAY'
  | 'PLAY_LAST_REPLAY';

export type RequestActionFn = (req: ActionRequest) => void;

export interface ReactorMode {
  readonly mode: ShootMode;
  readonly weaponId: string;
  readonly weaponDisplay: string;
  readonly participantIds: ReadonlyArray<string>;
  readonly totalDice: number;
  /** Pre-formatted dice readout, mirrors ShootCandidateMode.diceReadout. */
  readonly diceReadout: string;
}

export interface VisibleReactor {
  readonly id: string;
  readonly note: string;
  readonly modes: ReadonlyArray<ReactorMode>;
}

export interface ReactionTargetOption {
  readonly unitId: string;
  readonly selected: boolean;
}

export interface ReactionContext {
  readonly defenderFaction: 'A' | 'B';
  /** MOVE has a real path + scrubber; RALLY is stationary so scrubber hides. */
  readonly intent: 'MOVE' | 'RALLY';
  readonly markers: ReadonlyArray<ReactionMarker>;
  readonly currentT: number;
  readonly visibleReactors: ReadonlyArray<VisibleReactor>;
  /**
   * For command actions: list of all possible target movers. Defender picks
   * one as the marker target before placing markers. Undefined for solo.
   */
  readonly commandMovers?: ReadonlyArray<ReactionTargetOption>;
  /**
   * LOS-windows along the path expressed as t-ranges. Surfaced so the
   * scrubber UI can mirror the path's red "visible to enemies" segments
   * onto the time axis.
   */
  readonly windows?: ReadonlyArray<{ readonly startT: number; readonly endT: number }>;
}

export interface ShootCandidateMode {
  readonly mode: ShootMode;
  readonly weaponId: string;
  readonly weaponDisplay: string;
  readonly participantIds: ReadonlyArray<string>;
  readonly totalDice: number;
  /**
   * Pre-formatted dice readout — single-group `4d 5+` for level-0 shots,
   * heterogeneous form `4d (3@3+, 1@4+)` when combat-intel meta has
   * altered thresholds. Hud reads this verbatim so the picker stays
   * accurate when intel levels change between shot options.
   */
  readonly diceReadout: string;
}

export interface ShootCandidate {
  readonly targetId: string;
  readonly note: string;
  readonly modes: ReadonlyArray<ShootCandidateMode>;
}

export interface ShootContext {
  readonly shooterId: string;
  readonly candidates: ReadonlyArray<ShootCandidate>;
}

export interface MeleeCandidate {
  readonly targetId: string;
  readonly note: string;
}

export interface MeleeContext {
  readonly attackerId: string;
  readonly candidates: ReadonlyArray<MeleeCandidate>;
}

export interface TraversalContext {
  readonly canVault: boolean;
  readonly canClimb: boolean;
}

export interface MovePreviewContext {
  /** Whether "End prone" is currently toggled on for the in-progress move. */
  readonly endProne: boolean;
  /** Allow showing the end-prone toggle (false e.g. when in difficult terrain). */
  readonly canEndProne: boolean;
}

export interface CommandRallyCandidate {
  readonly id: string;
  readonly note: string;
  readonly isOfficer: boolean;
  readonly damaged: boolean;
  readonly selected: boolean;
}

export interface CommandRallyContext {
  readonly officerId: string;
  /** Includes officer (if damaged) + nearby allies. */
  readonly candidates: ReadonlyArray<CommandRallyCandidate>;
  /** Whether starting command activation is even possible (officer + ≥1 ally). */
  readonly canStart: boolean;
}

export interface CommandMoveParticipant {
  readonly unitId: string;
  readonly note: string;
  readonly included: boolean;
  /** Local target chosen by player; null if not yet set. */
  readonly target: { x: number; y: number } | null;
  readonly targetValid: boolean;
  readonly stance: 'STANDING' | 'CRAWL';
}

export interface CommandMoveContext {
  readonly officerId: string;
  /** Whether an officer-led command move is even possible (officer + ≥1 ally within 1 UD). */
  readonly canStart: boolean;
  /** Officer-side state when in setup phase. */
  readonly officerTarget?: { x: number; y: number };
  readonly officerStance?: 'STANDING' | 'CRAWL';
  readonly participants: ReadonlyArray<CommandMoveParticipant>;
}

export interface HudContext {
  readonly reaction?: ReactionContext;
  readonly shoot?: ShootContext;
  readonly melee?: MeleeContext;
  readonly traversal?: TraversalContext;
  readonly movePreview?: MovePreviewContext;
  readonly commandRally?: CommandRallyContext;
  readonly commandMove?: CommandMoveContext;
}

export class Hud {
  private actionsEl: HTMLElement;
  private logEl: HTMLElement;
  private roundEl: HTMLElement;
  private holderEl: HTMLElement;
  private momentumAEl: HTMLElement;
  private momentumBEl: HTMLElement;
  private activeEl: HTMLElement;
  private scrubberEl: HTMLElement;
  private scrubberInputEl: HTMLInputElement;
  private scrubberLabelEl: HTMLElement;
  private scrubberWindowsEl: HTMLElement | null = null;
  private timerEl: HTMLElement;
  private aiToggleA: HTMLInputElement;
  private aiToggleB: HTMLInputElement;
  private frameSvgEl: SVGSVGElement;
  private frameRectEl: SVGRectElement;
  private frameGlowEl: HTMLElement;
  private frameLength = 0;
  private logLines: string[] = [];
  private logWrapEl: HTMLElement;
  private logToggleEl: HTMLButtonElement;

  constructor(
    private dispatch: DispatchFn,
    private requestAction: RequestActionFn,
    private removeMarker: (index: number) => void,
    private onScrubberChange: (t: number) => void,
    private placeMarker: (
      shooterId: string,
      mode: ShootMode,
      weaponId: string,
      participantIds: ReadonlyArray<string>,
    ) => void,
    private onAiToggle: (faction: 'A' | 'B', enabled: boolean) => void,
    private onCommandRallyToggle: (unitId: string) => void,
    private onCommandMoveToggle: (unitId: string) => void,
    private onCommandMoveAim: (unitId: string) => void,
    private onSelectReactionTarget: (unitId: string) => void,
  ) {
    this.actionsEl = mustElement('hud-actions');
    this.logEl = mustElement('hud-log');
    this.roundEl = mustElement('hud-round');
    this.holderEl = mustElement('hud-holder');
    this.momentumAEl = mustElement('hud-momentum-a');
    this.momentumBEl = mustElement('hud-momentum-b');
    this.activeEl = mustElement('hud-active');
    this.scrubberEl = mustElement('hud-scrubber');
    this.scrubberInputEl = mustElement('hud-scrubber-input') as HTMLInputElement;
    this.scrubberLabelEl = mustElement('hud-scrubber-label');
    this.scrubberWindowsEl = document.getElementById('hud-scrubber-windows');
    this.timerEl = mustElement('hud-timer');
    this.aiToggleA = mustElement('hud-ai-a') as HTMLInputElement;
    this.aiToggleB = mustElement('hud-ai-b') as HTMLInputElement;
    // Reset checkboxes for a fresh battle (Phaser keeps the DOM around).
    this.aiToggleA.checked = false;
    this.aiToggleB.checked = false;
    this.aiToggleA.onchange = () =>
      this.onAiToggle('A', this.aiToggleA.checked);
    this.aiToggleB.onchange = () =>
      this.onAiToggle('B', this.aiToggleB.checked);
    this.frameSvgEl = mustElement('hud-frame') as unknown as SVGSVGElement;
    this.frameRectEl = mustElement('hud-frame-rect') as unknown as SVGRectElement;
    this.frameGlowEl = mustElement('hud-frame-glow');
    this.logWrapEl = mustElement('hud-log-wrap');
    this.logToggleEl = mustElement('hud-log-toggle') as HTMLButtonElement;
    this.logToggleEl.onclick = () => this.toggleLogCollapsed();
    // Restore last collapsed preference (Phaser keeps the DOM across scenes).
    try {
      if (localStorage.getItem('czl.logCollapsed') === '1') {
        this.logWrapEl.classList.add('collapsed');
        this.logToggleEl.textContent = '▲ log';
      } else {
        this.logWrapEl.classList.remove('collapsed');
        this.logToggleEl.textContent = '▼ log';
      }
    } catch {
      /* ignore */
    }
    this.resizeFrame();
    // Use a single tracked window listener that always points at the latest
    // Hud instance so re-creating BattleScene doesn't stack handlers.
    if (windowResizeHandler) {
      window.removeEventListener('resize', windowResizeHandler);
    }
    windowResizeHandler = () => this.resizeFrame();
    window.addEventListener('resize', windowResizeHandler);

    // For DOM elements that persist across scene re-creation we use `oninput`
    // / `onchange` (single-slot) instead of addEventListener (stacks).
    this.scrubberInputEl.oninput = () => {
      const t = parseFloat(this.scrubberInputEl.value);
      this.scrubberLabelEl.textContent = `Reaction t = ${t.toFixed(2)}`;
      this.onScrubberChange(t);
    };
  }

  update(
    state: GameState,
    selectedUnitId: string | null,
    aimMode: AimMode = 'idle',
    ctx?: HudContext,
  ): void {
    this.roundEl.textContent = String(state.initiative.round);
    this.holderEl.textContent = state.initiative.holder;
    this.holderEl.className = `holder-${state.initiative.holder}`;
    this.momentumAEl.textContent = String(state.initiative.momentum.A);
    this.momentumBEl.textContent = String(state.initiative.momentum.B);

    const act = state.initiative.activeActivation;
    if (act) {
      const remaining =
        act.actionsRemaining === -1 ? '∞' : String(act.actionsRemaining);
      const u = state.units.find((x) => x.id === act.unitId);
      const stance = u?.stance === 'PRONE' ? ' · prone' : '';
      this.activeEl.textContent = `· ${act.unitId} active (${act.kind}, ${remaining} left${stance})`;
    } else {
      this.activeEl.textContent = '';
    }

    const showScrubber =
      aimMode === 'reaction-phase' && ctx?.reaction?.intent === 'MOVE';
    this.scrubberEl.hidden = !showScrubber;
    if (showScrubber) {
      this.renderScrubberWindows(ctx?.reaction?.windows ?? []);
    }

    this.renderActions(state, selectedUnitId, aimMode, ctx);
  }

  /**
   * Mirror the path's red LOS-window segments onto the scrubber timeline.
   * Each window becomes an absolutely-positioned red bar inside
   * #hud-scrubber-windows so the player's eye can track time-on-axis the
   * same way they track distance-on-path.
   */
  private renderScrubberWindows(
    windows: ReadonlyArray<{ startT: number; endT: number }>,
  ): void {
    const host = this.scrubberWindowsEl;
    if (!host) return;
    host.innerHTML = '';
    for (const w of windows) {
      const bar = document.createElement('div');
      bar.className = 'hud-scrubber-window';
      const startPct = Math.max(0, Math.min(100, w.startT * 100));
      const widthPct = Math.max(0, Math.min(100, (w.endT - w.startT) * 100));
      bar.style.left = `${startPct}%`;
      bar.style.width = `${widthPct}%`;
      host.appendChild(bar);
    }
  }

  setScrubberValue(t: number): void {
    this.scrubberInputEl.value = t.toFixed(2);
    this.scrubberLabelEl.textContent = `Reaction t = ${t.toFixed(2)}`;
  }

  setTimer(phase: string, secondsLeft: number): void {
    this.timerEl.hidden = false;
    this.timerEl.textContent = `⏱ ${phase} ${Math.max(0, secondsLeft).toFixed(1)}s`;
    if (secondsLeft <= 5) this.timerEl.style.color = '#ff6a6a';
    else if (secondsLeft <= 10) this.timerEl.style.color = '#ffae6a';
    else this.timerEl.style.color = '#ffd166';
  }

  hideTimer(): void {
    this.timerEl.hidden = true;
    this.timerEl.textContent = '';
  }

  private resizeFrame(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.frameSvgEl.setAttribute('width', String(w));
    this.frameSvgEl.setAttribute('height', String(h));
    this.frameRectEl.setAttribute('width', String(Math.max(0, w - 6)));
    this.frameRectEl.setAttribute('height', String(Math.max(0, h - 6)));
    try {
      this.frameLength = this.frameRectEl.getTotalLength();
    } catch {
      this.frameLength = 2 * (w + h);
    }
  }

  /**
   * Programmatically flip an AI toggle and fire the onAiToggle callback so
   * the BattleScene's AI ticker actually starts. Used by roguelite mode to
   * force enemy faction to AI control from the first frame.
   */
  setAi(faction: 'A' | 'B', enabled: boolean): void {
    const checkbox = faction === 'A' ? this.aiToggleA : this.aiToggleB;
    if (checkbox.checked === enabled) return;
    checkbox.checked = enabled;
    this.onAiToggle(faction, enabled);
  }

  /**
   * Show the operator's faction-colored border around the screen. When
   * `fraction` is provided (0..1), the border erases counter-clockwise as it
   * shrinks toward 0 (timer countdown).
   */
  setFrame(faction: 'A' | 'B' | null, fraction?: number): void {
    if (!faction) {
      this.frameSvgEl.setAttribute('hidden', '');
      this.frameGlowEl.setAttribute('hidden', '');
      this.frameGlowEl.classList.remove('faction-A', 'faction-B');
      return;
    }
    this.frameSvgEl.removeAttribute('hidden');
    this.frameGlowEl.removeAttribute('hidden');
    this.frameGlowEl.classList.remove('faction-A', 'faction-B');
    this.frameGlowEl.classList.add(`faction-${faction}`);
    this.frameRectEl.style.stroke =
      faction === 'A'
        ? 'rgba(106, 176, 255, 0.85)'
        : 'rgba(255, 138, 106, 0.85)';
    if (fraction === undefined) {
      this.frameRectEl.style.strokeDasharray = 'none';
      this.frameRectEl.style.strokeDashoffset = '0';
    } else {
      const f = Math.max(0, Math.min(1, fraction));
      this.frameRectEl.style.strokeDasharray = String(this.frameLength);
      this.frameRectEl.style.strokeDashoffset = String(
        (1 - f) * this.frameLength,
      );
    }
  }

  pushEvents(events: ReadonlyArray<GameEvent>): void {
    for (const ev of events) this.logLines.push(formatEvent(ev));
    while (this.logLines.length > 100) this.logLines.shift();
    this.logEl.textContent = this.logLines.slice(-12).join('\n');
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private toggleLogCollapsed(): void {
    const collapsed = this.logWrapEl.classList.toggle('collapsed');
    this.logToggleEl.textContent = collapsed ? '▲ log' : '▼ log';
    try {
      localStorage.setItem('czl.logCollapsed', collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  pushError(message: string): void {
    this.logLines.push(`✗ ${message}`);
    while (this.logLines.length > 100) this.logLines.shift();
    this.logEl.textContent = this.logLines.slice(-12).join('\n');
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private renderActions(
    state: GameState,
    selectedUnitId: string | null,
    aimMode: AimMode,
    ctx: HudContext | undefined,
  ): void {
    this.actionsEl.innerHTML = '';

    if (aimMode === 'aim-move-stance') {
      const header = document.createElement('h3');
      header.textContent = 'Choose movement stance';
      this.actionsEl.appendChild(header);
      this.addReqBtn('Standing — full distance', 'CHOOSE_MOVE_STANDING');
      this.addReqBtn('Crawl — 1 unit, ends prone', 'CHOOSE_MOVE_CRAWL');
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.onclick = () => this.requestAction('CANCEL_AIM');
      this.actionsEl.appendChild(cancel);
      return;
    }

    if (aimMode === 'aim-move') {
      const note = document.createElement('div');
      note.style.color = '#cfe8cf';
      note.style.whiteSpace = 'pre-wrap';
      note.textContent =
        'Click map to confirm move target.\nRed segments = enemy LOS windows.\nESC or right-click to cancel.';
      this.actionsEl.appendChild(note);
      // End-of-move stance toggle — visible only for standing moves where the
      // rule allows ending prone.
      if (ctx?.movePreview?.canEndProne) {
        const toggle = document.createElement('button');
        const on = ctx.movePreview.endProne;
        toggle.textContent = on
          ? '✓ End prone (drop after move)'
          : '☐ End prone (drop after move)';
        toggle.style.background = on ? '#2a4a2a' : '#1a2a1a';
        toggle.onclick = () => this.requestAction('TOGGLE_END_PRONE');
        this.actionsEl.appendChild(toggle);
      }
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.onclick = () => this.requestAction('CANCEL_AIM');
      this.actionsEl.appendChild(cancel);
      return;
    }

    if (aimMode === 'aim-shoot' && ctx?.shoot) {
      this.renderShootPicker(ctx.shoot);
      return;
    }

    if (aimMode === 'aim-melee' && ctx?.melee) {
      this.renderMeleePicker(ctx.melee);
      return;
    }

    if (aimMode === 'reaction-phase' && ctx?.reaction) {
      this.renderReactionPanel(ctx.reaction);
      return;
    }

    if (aimMode === 'aim-command-rally' && ctx?.commandRally) {
      this.renderCommandRallyPanel(ctx.commandRally);
      return;
    }

    if (aimMode === 'aim-command-move-officer-stance') {
      const header = document.createElement('h3');
      header.textContent = 'Command Move — officer stance';
      this.actionsEl.appendChild(header);
      this.addReqBtn('Standing — full distance', 'CHOOSE_CMD_MOVE_STANDING');
      this.addReqBtn('Crawl — 1 unit, ends prone', 'CHOOSE_CMD_MOVE_CRAWL');
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.onclick = () => this.requestAction('CANCEL_AIM');
      this.actionsEl.appendChild(cancel);
      return;
    }

    if (aimMode === 'aim-command-move-officer') {
      const note = document.createElement('div');
      note.style.color = '#cfe8cf';
      note.style.whiteSpace = 'pre-wrap';
      note.textContent =
        'Command Move — click map to confirm officer\'s endpoint.\nNearby allies will be able to pick targets within 1 UD of it.';
      this.actionsEl.appendChild(note);
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.onclick = () => this.requestAction('CANCEL_AIM');
      this.actionsEl.appendChild(cancel);
      return;
    }

    if (aimMode === 'aim-command-move-setup' && ctx?.commandMove) {
      this.renderCommandMoveSetupPanel(ctx.commandMove);
      return;
    }

    if (aimMode === 'aim-command-move-participant' && ctx?.commandMove) {
      const note = document.createElement('div');
      note.style.color = '#cfe8cf';
      note.style.whiteSpace = 'pre-wrap';
      note.textContent =
        'Click map to set this ally\'s endpoint.\nMust be within 1 unit-distance of officer\'s endpoint (green ring).';
      this.actionsEl.appendChild(note);
      const back = document.createElement('button');
      back.textContent = '← Back to setup';
      back.onclick = () => this.requestAction('BACK_TO_CMD_MOVE_SETUP');
      this.actionsEl.appendChild(back);
      return;
    }

    const act = state.initiative.activeActivation;
    if (act) {
      this.renderActivationActions(state, act, ctx);
      return;
    }

    const selected = selectedUnitId
      ? state.units.find((u) => u.id === selectedUnitId)
      : undefined;
    if (selected && selected.faction === state.initiative.holder) {
      const header = document.createElement('h3');
      header.textContent = `Activate ${selected.id} (${selected.quality}+)`;
      this.actionsEl.appendChild(header);
      const cur = state.initiative.momentum[selected.faction];
      const cost = selected.quality;
      if (cur >= cost) {
        this.addBtn(`Spend (${cost})`, {
          type: 'ACTIVATE_SPEND',
          unitId: selected.id,
        });
      } else {
        this.addBtn(`Overdraft (deficit ${cost - cur})`, {
          type: 'ACTIVATE_OVERDRAFT',
          unitId: selected.id,
        });
      }
      this.addBtn(`Check (roll ≥ ${selected.quality})`, {
        type: 'ACTIVATE_CHECK',
        unitId: selected.id,
      });
    } else if (selected) {
      const note = document.createElement('div');
      note.style.color = '#7a9a7a';
      note.textContent = `${selected.id} is on ${selected.faction}; current holder is ${state.initiative.holder}.`;
      this.actionsEl.appendChild(note);
    } else {
      const note = document.createElement('div');
      note.style.color = '#7a9a7a';
      note.textContent = 'Select a unit to activate, or pass initiative.';
      this.actionsEl.appendChild(note);
    }

    const sep = document.createElement('div');
    sep.style.borderTop = '1px solid #2a3a2a';
    sep.style.margin = '6px 0';
    this.actionsEl.appendChild(sep);
    this.addBtn('Pass Initiative', { type: 'PASS_INITIATIVE' });

    const sep2 = document.createElement('div');
    sep2.style.borderTop = '1px solid #2a3a2a';
    sep2.style.margin = '6px 0';
    this.actionsEl.appendChild(sep2);
    const replayHeader = document.createElement('h3');
    replayHeader.textContent = 'Replay';
    this.actionsEl.appendChild(replayHeader);
    this.addReqBtn('Save current battle', 'SAVE_REPLAY');
  }

  private renderActivationActions(
    state: GameState,
    act: NonNullable<GameState['initiative']['activeActivation']>,
    ctx: HudContext | undefined,
  ): void {
    const activeUnit = state.units.find((u) => u.id === act.unitId);
    const header = document.createElement('h3');
    header.textContent = `Active: ${act.unitId} (${act.kind})`;
    this.actionsEl.appendChild(header);

    if (activeUnit) {
      const canMove =
        activeUnit.damage !== 'IMPEDED' && activeUnit.damage !== 'SUPPRESSED';
      const canShoot =
        activeUnit.damage !== 'SUPPRESSED' &&
        (ctx?.shoot?.candidates.length ?? 0) > 0;
      const canMelee = (ctx?.melee?.candidates.length ?? 0) > 0;
      const canRally =
        activeUnit.damage === 'IMPEDED' || activeUnit.damage === 'SUPPRESSED';

      if (canMove) this.addReqBtn('Move', 'REQUEST_MOVE');
      if (canShoot) this.addReqBtn('Shoot…', 'REQUEST_SHOOT');
      if (canMelee) this.addReqBtn('Melee…', 'REQUEST_MELEE');
      if (canRally) this.addReqBtn('Rally', 'REQUEST_RALLY');
      if (canMove && ctx?.traversal?.canVault) {
        this.addReqBtn('Vault (over low wall)', 'REQUEST_VAULT');
      }
      if (canMove && ctx?.traversal?.canClimb) {
        this.addReqBtn('Climb (high wall, ends activation)', 'REQUEST_CLIMB');
      }
      if (ctx?.commandRally?.canStart) {
        this.addReqBtn(
          'Command Rally… (officer + nearby allies)',
          'REQUEST_COMMAND_RALLY',
        );
      }
      if (canMove && ctx?.commandMove?.canStart) {
        this.addReqBtn(
          'Command Move… (officer + nearby allies)',
          'REQUEST_COMMAND_MOVE',
        );
      }
    }
    if (act.kind === 'CHECK_SUCCESS') {
      this.addBtn('End Activation', { type: 'END_ACTIVATION' });
    }
  }

  private renderShootPicker(shoot: ShootContext): void {
    const header = document.createElement('h3');
    header.textContent = `Shoot — ${shoot.shooterId}`;
    this.actionsEl.appendChild(header);

    if (shoot.candidates.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = '#7a9a7a';
      empty.textContent = '(no enemies in LOS)';
      this.actionsEl.appendChild(empty);
    } else {
      for (const c of shoot.candidates) {
        const sub = document.createElement('div');
        sub.style.color = '#cfe8cf';
        sub.style.fontSize = '11px';
        sub.style.marginTop = '6px';
        sub.textContent = `→ ${c.targetId} ${c.note}`;
        this.actionsEl.appendChild(sub);
        for (const m of c.modes) {
          const b = document.createElement('button');
          const partsLabel =
            m.participantIds.length > 0
              ? ` w/ ${m.participantIds.join(',')}`
              : '';
          b.textContent = `${m.mode} [${m.weaponDisplay}]${partsLabel} (${m.diceReadout})`;
          b.onclick = () =>
            this.dispatch({
              type: 'SHOOT',
              mode: m.mode,
              shooterId: shoot.shooterId,
              targetId: c.targetId,
              weaponId: m.weaponId,
              participantIds: m.participantIds,
            });
          this.actionsEl.appendChild(b);
        }
      }
    }
    const sep = document.createElement('div');
    sep.style.borderTop = '1px solid #2a3a2a';
    sep.style.margin = '6px 0';
    this.actionsEl.appendChild(sep);
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => this.requestAction('CANCEL_AIM');
    this.actionsEl.appendChild(cancel);
  }

  private renderMeleePicker(melee: MeleeContext): void {
    const header = document.createElement('h3');
    header.textContent = `Melee — ${melee.attackerId}`;
    this.actionsEl.appendChild(header);

    if (melee.candidates.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = '#7a9a7a';
      empty.textContent = '(no enemies in base contact)';
      this.actionsEl.appendChild(empty);
    } else {
      for (const c of melee.candidates) {
        const b = document.createElement('button');
        b.textContent = `Charge ${c.targetId} ${c.note}`;
        b.onclick = () =>
          this.dispatch({
            type: 'MELEE',
            attackerId: melee.attackerId,
            defenderId: c.targetId,
            isCharging: true,
          });
        this.actionsEl.appendChild(b);
      }
    }
    const sep = document.createElement('div');
    sep.style.borderTop = '1px solid #2a3a2a';
    sep.style.margin = '6px 0';
    this.actionsEl.appendChild(sep);
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => this.requestAction('CANCEL_AIM');
    this.actionsEl.appendChild(cancel);
  }

  private renderCommandRallyPanel(ctx: CommandRallyContext): void {
    const header = document.createElement('h3');
    header.textContent = `Command Rally — ${ctx.officerId}`;
    this.actionsEl.appendChild(header);
    const help = document.createElement('div');
    help.style.color = '#7a9a7a';
    help.style.fontSize = '11px';
    help.style.lineHeight = '1.4';
    help.textContent =
      'Select damaged units within 1 unit-distance. All roll a rally check using the officer\'s quality.';
    this.actionsEl.appendChild(help);

    if (ctx.candidates.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = '#7a9a7a';
      empty.textContent = '(no eligible units)';
      this.actionsEl.appendChild(empty);
    }

    for (const c of ctx.candidates) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '6px';
      row.style.padding = '4px 6px';
      row.style.background = c.selected ? 'rgba(154, 240, 154, 0.10)' : 'transparent';
      row.style.border = '1px solid #2a3a2a';
      row.style.cursor = c.damaged ? 'pointer' : 'not-allowed';
      row.style.opacity = c.damaged ? '1' : '0.5';
      const checkBox = document.createElement('span');
      checkBox.textContent = c.selected ? '☑' : '☐';
      checkBox.style.fontSize = '14px';
      const label = document.createElement('span');
      label.style.fontSize = '12px';
      label.textContent = `${c.id}${c.isOfficer ? ' ⭐' : ''} ${c.note}`;
      row.appendChild(checkBox);
      row.appendChild(label);
      if (c.damaged) {
        row.onclick = () => this.onCommandRallyToggle(c.id);
      }
      this.actionsEl.appendChild(row);
    }

    const sep = document.createElement('div');
    sep.style.borderTop = '1px solid #2a3a2a';
    sep.style.margin = '6px 0';
    this.actionsEl.appendChild(sep);

    const confirm = document.createElement('button');
    const selectedCount = ctx.candidates.filter((c) => c.selected).length;
    confirm.textContent = `Confirm (${selectedCount} units)`;
    const officerSelected = ctx.candidates.some(
      (c) => c.id === ctx.officerId && c.selected,
    );
    const officerCanRally = ctx.candidates.find(
      (c) => c.id === ctx.officerId && c.damaged,
    );
    // Need at least 1 ally selected; officer is optional unless they're
    // the only damaged one (then they're effectively soloing — but rule
    // requires ≥1 ally, so block).
    const allySelected = ctx.candidates.some(
      (c) => c.id !== ctx.officerId && c.selected,
    );
    confirm.disabled = !allySelected;
    confirm.onclick = () => this.requestAction('CONFIRM_COMMAND_RALLY');
    this.actionsEl.appendChild(confirm);
    void officerSelected;
    void officerCanRally;

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => this.requestAction('CANCEL_AIM');
    this.actionsEl.appendChild(cancel);
  }

  private renderCommandMoveSetupPanel(ctx: CommandMoveContext): void {
    const header = document.createElement('h3');
    header.textContent = `Command Move — ${ctx.officerId}`;
    this.actionsEl.appendChild(header);
    if (ctx.officerTarget && ctx.officerStance) {
      const sub = document.createElement('div');
      sub.style.fontSize = '11px';
      sub.style.color = '#9af09a';
      sub.textContent = `Officer endpoint set (${ctx.officerStance.toLowerCase()})`;
      this.actionsEl.appendChild(sub);
    }
    const help = document.createElement('div');
    help.style.color = '#7a9a7a';
    help.style.fontSize = '11px';
    help.style.marginTop = '4px';
    help.textContent =
      'Tick allies to include. For each, click "Aim" then click the map within the green ring.';
    this.actionsEl.appendChild(help);

    if (ctx.participants.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = '#7a9a7a';
      empty.textContent = '(no nearby allies)';
      this.actionsEl.appendChild(empty);
    }

    for (const p of ctx.participants) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '6px';
      row.style.padding = '4px 6px';
      row.style.background = p.included ? 'rgba(154, 240, 154, 0.10)' : 'transparent';
      row.style.border = '1px solid #2a3a2a';
      const checkBox = document.createElement('span');
      checkBox.textContent = p.included ? '☑' : '☐';
      checkBox.style.fontSize = '14px';
      checkBox.style.cursor = 'pointer';
      checkBox.onclick = () => this.onCommandMoveToggle(p.unitId);
      row.appendChild(checkBox);
      const label = document.createElement('span');
      label.style.fontSize = '12px';
      label.style.flex = '1';
      const targetIndicator = p.target
        ? p.targetValid
          ? '✓ target set'
          : '✗ target out of range'
        : '— no target —';
      label.textContent = `${p.unitId} ${p.note} · ${targetIndicator}`;
      label.style.color = p.target && !p.targetValid ? '#ff8a6a' : '#cfe8cf';
      row.appendChild(label);
      if (p.included) {
        const aimBtn = document.createElement('button');
        aimBtn.textContent = p.target ? 'Re-aim' : 'Aim';
        aimBtn.style.padding = '2px 8px';
        aimBtn.onclick = () => this.onCommandMoveAim(p.unitId);
        row.appendChild(aimBtn);
      }
      this.actionsEl.appendChild(row);
    }

    const sep = document.createElement('div');
    sep.style.borderTop = '1px solid #2a3a2a';
    sep.style.margin = '6px 0';
    this.actionsEl.appendChild(sep);

    const includedCount = ctx.participants.filter((p) => p.included).length;
    const allValid = ctx.participants.every(
      (p) => !p.included || (p.target !== null && p.targetValid),
    );
    const confirm = document.createElement('button');
    confirm.textContent = `Confirm (${includedCount} ally${includedCount === 1 ? '' : 's'})`;
    confirm.disabled = includedCount === 0 || !allValid;
    confirm.onclick = () => this.requestAction('CONFIRM_COMMAND_MOVE');
    this.actionsEl.appendChild(confirm);

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => this.requestAction('CANCEL_AIM');
    this.actionsEl.appendChild(cancel);
  }

  private renderReactionPanel(reaction: ReactionContext): void {
    const header = document.createElement('h3');
    header.textContent =
      reaction.intent === 'MOVE'
        ? `Reaction Phase — ${reaction.defenderFaction} defends move`
        : `Reaction Phase — ${reaction.defenderFaction} defends rally`;
    this.actionsEl.appendChild(header);

    // Command-action target switcher: defender selects which mover the next
    // marker(s) target. Markers carry the selected target via marker.targetUnitId.
    if (reaction.commandMovers && reaction.commandMovers.length > 1) {
      const switcherHeader = document.createElement('h3');
      switcherHeader.textContent = 'Reaction target';
      this.actionsEl.appendChild(switcherHeader);
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.flexWrap = 'wrap';
      row.style.gap = '4px';
      for (const opt of reaction.commandMovers) {
        const btn = document.createElement('button');
        btn.textContent = `${opt.selected ? '◉' : '○'} ${opt.unitId}`;
        btn.style.background = opt.selected ? '#2a4a2a' : '#1a2a1a';
        btn.onclick = () => this.onSelectReactionTarget(opt.unitId);
        row.appendChild(btn);
      }
      this.actionsEl.appendChild(row);
    }

    const help = document.createElement('div');
    help.style.color = '#7a9a7a';
    help.style.fontSize = '11px';
    help.style.lineHeight = '1.4';
    help.textContent =
      reaction.intent === 'MOVE'
        ? 'Drag scrubber to preview path. Below: enemies that have LOS at the current t — click to place a marker. Markers resolve in t-order; first hit stops the move.'
        : 'Rally is stationary. Below: enemies with LOS to the rallying unit — click to place a reaction marker.';
    this.actionsEl.appendChild(help);

    const visHeader = document.createElement('h3');
    visHeader.textContent =
      reaction.intent === 'MOVE'
        ? `Place marker @ t=${reaction.currentT.toFixed(2)}:`
        : 'Place marker:';
    this.actionsEl.appendChild(visHeader);
    if (reaction.visibleReactors.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = '#7a9a7a';
      empty.style.fontSize = '11px';
      empty.textContent =
        reaction.intent === 'MOVE'
          ? '(no eligible enemies see you here — drag scrubber)'
          : '(no eligible enemies see this unit)';
      this.actionsEl.appendChild(empty);
    } else {
      for (const v of reaction.visibleReactors) {
        const sub = document.createElement('div');
        sub.style.color = '#cfe8cf';
        sub.style.fontSize = '11px';
        sub.style.marginTop = '4px';
        sub.textContent = `${v.id} ${v.note}`;
        this.actionsEl.appendChild(sub);
        for (const m of v.modes) {
          const b = document.createElement('button');
          const partsLabel =
            m.participantIds.length > 0
              ? ` w/ ${m.participantIds.join(',')}`
              : '';
          b.textContent = `+ ${m.mode} [${m.weaponDisplay}]${partsLabel} (${m.diceReadout})`;
          b.onclick = () =>
            this.placeMarker(v.id, m.mode, m.weaponId, m.participantIds);
          this.actionsEl.appendChild(b);
        }
      }
    }

    const markersHeader = document.createElement('h3');
    markersHeader.textContent = `Placed markers (${reaction.markers.length})`;
    this.actionsEl.appendChild(markersHeader);
    if (reaction.markers.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = '#7a9a7a';
      empty.style.fontSize = '11px';
      empty.textContent = '(none — confirm to skip reactions)';
      this.actionsEl.appendChild(empty);
    } else {
      reaction.markers.forEach((m, i) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        const span = document.createElement('span');
        const partsLabel =
          m.participantIds.length > 0
            ? ` w/ ${m.participantIds.join(',')}`
            : '';
        span.textContent = `t=${m.atT.toFixed(2)} · ${m.shooterId} ${m.mode}${partsLabel}`;
        row.appendChild(span);
        const rm = document.createElement('button');
        rm.textContent = '×';
        rm.style.padding = '2px 8px';
        rm.onclick = () => this.removeMarker(i);
        row.appendChild(rm);
        this.actionsEl.appendChild(row);
      });
    }

    const sep = document.createElement('div');
    sep.style.borderTop = '1px solid #2a3a2a';
    sep.style.margin = '6px 0';
    this.actionsEl.appendChild(sep);

    const confirm = document.createElement('button');
    confirm.textContent =
      reaction.markers.length === 0
        ? 'Confirm (no reactions)'
        : `Confirm (${reaction.markers.length} marker${reaction.markers.length === 1 ? '' : 's'})`;
    confirm.onclick = () => this.requestAction('CONFIRM_REACTION');
    this.actionsEl.appendChild(confirm);

    if (reaction.markers.length > 0) {
      const skip = document.createElement('button');
      skip.textContent = 'Clear all & skip';
      skip.onclick = () => this.requestAction('SKIP_REACTION');
      this.actionsEl.appendChild(skip);
    }

    const note = document.createElement('div');
    note.style.color = '#7a9a7a';
    note.style.fontSize = '11px';
    note.style.marginTop = '6px';
    note.textContent =
      'Handoff is irreversible — only Confirm to commit.';
    this.actionsEl.appendChild(note);
  }

  private addBtn(label: string, cmd: Command): void {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => this.dispatch(cmd);
    this.actionsEl.appendChild(b);
  }

  private addReqBtn(label: string, req: ActionRequest): void {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => this.requestAction(req);
    this.actionsEl.appendChild(b);
  }
}

let windowResizeHandler: (() => void) | null = null;

const mustElement = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from DOM`);
  return el;
};

const formatEvent = (e: GameEvent): string => {
  switch (e.type) {
    case 'MOMENTUM_SPENT':
      return `· ${e.faction} spent ${e.amount} momentum`;
    case 'OVERDRAFT_DECLARED':
      return `· ${e.unitId} overdrafted (deficit ${e.deficit})`;
    case 'ACTIVATION_BEGAN':
      return `▶ ${e.unitId} activated (${e.kind})`;
    case 'ACTIVATION_CHECK_ROLLED':
      return `🎲 ${e.unitId} check ${e.threshold}+ → rolled ${e.roll} → ${e.success ? '✓' : '✗'}`;
    case 'ACTIVATION_ENDED':
      return `■ ${e.unitId} activation ended (${e.reason})`;
    case 'INITIATIVE_TURNOVER':
      return `↔ Initiative ${e.from} → ${e.to} (${e.reason}, +${e.momentumGranted})`;
    case 'MOVE_RESOLVED':
      return `→ ${e.unitId} moved ${e.distance.toFixed(0)}px (${e.stopReason})${e.interruptedByMarker >= 0 ? ` interrupted@m${e.interruptedByMarker}` : ''}`;
    case 'SHOT_RESOLVED':
      return `🔫 ${e.shooterId}${e.participantIds.length > 0 ? `+${e.participantIds.length}` : ''} → ${e.targetId} (${e.mode} ${e.weaponMode}): ${e.hits}/${e.diceCount} hits, ${e.beforeDamage}→${e.afterDamage}${e.coverApplied ? ' (cover)' : ''}`;
    case 'MELEE_RESOLVED':
      return `⚔ ${e.attackerId} vs ${e.defenderId}: ${e.attackerHits}-${e.defenderHits} → ${e.winnerId} wins`;
    case 'RALLY_ROLLED':
      return `🎯 ${e.unitId} rally ${e.threshold}+ → ${e.roll} → ${e.success ? `${e.beforeDamage}→${e.afterDamage}` : '✗'}`;
  }
};
