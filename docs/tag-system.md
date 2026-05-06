# Tag system — single source of truth

> **TL;DR.** Every unit has a `traits: string[]` field. **Trait = tag**. The
> rules engine queries by id only; tags are not divided into "real traits"
> vs "categories" at the type level. New rule-modifiers and new
> classifications all go through the same registry.

---

## 1. Why one system

Earlier roadmap drafts had a separate `category` field for combat-intel
meta targeting. That would have created two parallel tag namespaces. The
unified design (this doc) treats *every* unit-level descriptor — abilities,
classifications, future state markers — as a single tag list. Adding a
new rule that depends on a unit "being a thing" means: declare the tag
once, then any rule can ask `unitHasTrait(u, 'X')`.

This means CUMBERSOME (already an ability) and INFANTRY (a classification)
sit side by side in the registry. The registry's `kind` field documents
the intent for humans / UI grouping; the engine doesn't read it.

---

## 2. The query API (use exclusively)

In `src/core/traits/types.ts`:

| Function | Purpose |
|---|---|
| `unitHasTrait(u, id)` | Boolean presence check |
| `getUnitTraits(u)` | Iterate all parsed `(id, param)` instances |
| `sumTraitParams(u, id)` | Sum across instances — `ARMOR:1 + ARMOR:2 = 3` |
| `findHighestLevelByTag(u, levels)` | Max value across `Record<tag, level>` for any tag the unit carries |
| `parseTrait(raw)` | Parse `'ID'` / `'ID:N'` / `'ID(N)'` strings |

**Don't use `unit.traits.includes('X')`** anywhere — that bypasses param
parsing (`'ARMOR:2'.includes('ARMOR') === true` but ID extraction is
needed) and breaks consistency. Audit pass on 2026-04-29 caught 9 such
drifted call sites; all replaced with `unitHasTrait`.

---

## 3. Registry — current contents

Source: `src/core/traits/registry.ts`. **Status legend:**

- ✓ wired = engine reads this and changes behaviour
- ◷ stub = declared, not yet wired
- ○ classification = pure tag, no inherent behaviour

| ID | Kind | Status | Where it's read |
|---|---|---|---|
| OFFICER | ability | ✓ | reducer (COMMAND_MOVE/RALLY validation, rally aura), shooting (COMBINED gate), shoot_modes (officer LOS), AI eval (ally aura), candidates (command-* generators) |
| STALWART | ability | ✓ | reducer (`meleeIgnoresStatus`) |
| FRAGILE | ability | ✓ | shooting (+1 to hit count → cumulative ladder advances one extra tier per shot, so 2 hits = KILLED per rule 4.3) |
| ARMOR | ability(param) | ✓ | shooting (`sumTraitParams` for hit absorption) |
| CUMBERSOME | ability | ✓ | reducer (`capActionsForTraits` → max 1 action) |
| TOUGH | ability | ✓ | shooting (once-per-match save), AI eval (save value) |
| STEALTH | ability | ✓ | resolution/stealth.ts (path-immunity), reducer (MOVE/CRAWL window short-circuit), AI reaction.ts (planner skip), AI eval (cover-bonus) |
| CANNON_FODDER | ability | ✓ | reducer (`reactionOutcomeAfterFodder` — own-unit kill skips turnover) |
| FANATIC | ability | ✓ | reducer (`resolveReactionPlan` / `resolveGroupReactionPlan` — IMPEDED-only reaction hits don't halt the path) |
| TOUGH (older note) | ability | ✓ | (see TOUGH above) |
| IMPULSIVE_AGGRESSIVE | ability | ✓ | reducer (`activateCheck` failure branch + `turnover` outgoing-side prelude), commands/impulsive.ts (executor + shoot/move pickers; forced-move 走 `resolveReactionPlan` 完整流程含反應射擊，但跳過 `processPostAction` 不觸發易手) |
| AGITATOR | ability(param) | ◷ | declared only |
| WARLORD | ability | ◷ | declared only — depends on Red faction |
| MARTYRDOM | ability | ◷ | declared only — depends on militia faction |
| **INFANTRY** | category | ○ | unit JSONs only — *consumed* by future combat-intel meta lookup |
| **BEAST** | category | ○ | same as above — biological / non-vehicular |
| **HEAVY** | category | ○ | same as above |
| **CYBORG** | category | ○ | same |
| **MECH** | category | ○ | same |
| **COMMAND** | category | ○ | same — flag for officer-class units |
| NO_PRONE | ability | ✓ | reducer (CRAWL refusal, MOVE/COMMAND_MOVE endProne stripping, post-command `enforceNoProne` safeguard auto-stands), BattleScene (skip stance picker, `canEndProne` false) |
| NO_CLIMB | ability | ✓ | reducer (CLIMB refusal), BattleScene (`buildTraversalContext` masks canClimb) |
| NO_VAULT | ability | ✓ | reducer (VAULT refusal), BattleScene (`buildTraversalContext` masks canVault) |
| DOOR_OPERATOR | ability | ✓ | reducer (`operateDoorAction` 必要 trait,無此 trait 無法開關門),BattleScene (`buildTraversalContext` 計算 `canOperateDoor`)。穿門(`PASS_DOOR`)不需要此 trait —— 開著的門誰都能走過。 |

---

## 4. Where tags are queried today

Mapped per file. Paths use `unitHasTrait` after the 2026-04-29 audit.

### `src/core/commands/reducer.ts`
- `meleeIgnoresStatus(u)` → STALWART (via flag)
- `capActionsForTraits(u)` → CUMBERSOME (via flag)
- `commandMoveAction` → OFFICER required on cmd.officerId
- `commandRallyAction` → OFFICER required on cmd.officerId
- `rallyAction` → looks for nearby OFFICER ally to borrow quality
- `crawlAction` → throws if NO_PRONE
- `vaultAction` → throws if NO_VAULT
- `climbAction` → throws if NO_CLIMB
- `moveAction` / `commandMoveAction` → strip endProne / CRAWL stance for NO_PRONE participants
- `enforceNoProne` (post-command) → auto-stands any NO_PRONE unit observed PRONE

### `src/core/resolution/shooting.ts`
- `resolveShot` → COMBINED mode requires shooter is OFFICER
- damage application reads FRAGILE, ARMOR, TOUGH

### `src/core/resolution/shoot_modes.ts`
- `participantNeedsLosToOfficer` → reads NO_OFFICER_LOS_FOR_COMBINED
- `listAvailableShootModes` → COMBINED only when shooter is OFFICER

### `src/core/resolution/stealth.ts`
- `hasStealthBypass` → STEALTH

### `src/ai/eval.ts`
- `traitEvalHooks.OFFICER` — formation aura
- `traitEvalHooks.TOUGH` — once-per-match save valuation
- `traitEvalHooks.STEALTH` — cover-position bonus

### `src/ai/controllers/candidates.ts`
- `generateCommandRallyCandidates` → OFFICER
- `generateCommandMoveCandidates` → OFFICER

### `src/presentation/scenes/BattleScene.ts`
- `commandMoveOfficer` / `commandRallyOfficer` resolution → OFFICER (UI gate)
- HUD command-rally / command-move pickers → OFFICER

---

## 5. Likely future tag-query points (not wired yet)

These are sites where future rule additions will plausibly want a tag
check. Listed so the reader knows where to look when adding a rule.
**No code stubs added today** — adding placeholder branches without
intent is just clutter.

### Activation handlers (reducer)
- `activateSpend` / `activateCheck` — AGITATOR(N): allow ally within
  1 UD to pay N momentum to activate this unit
- `activateCheck` failure path — WARLORD: red officer can execute a
  conscript to convert failure to success

### Movement handlers (reducer)
- `vaultAction` / `climbAction` — could gate by trait (e.g. CUMBERSOME
  blocks climb)
- `moveAction` — IMPULSIVE: forced movement on activation start /
  initiative loss

### Damage / status (resolution)
- `applyHits` / `resolveShot` damage step — CANNON_FODDER: own-faction
  death does not trigger turnover
- `resolveShot` damage step — MARTYRDOM: militia gets reserve momentum
  on fanatic death

### Command system
- `chooseAiCommand` — IMPULSIVE forced behaviour overrides AI plan

### Meta upgrade (combat intel)
- `resolveShot` dice profile — `findHighestLevelByTag(target,
  campaign.combatIntel.shoot)` to read the highest meta-intel level
  the player has unlocked vs this target's tags
- `resolveMelee` (when implemented) — same pattern with
  `combatIntel.melee`

### Scenario / mission setup
- Mission generators — could filter enemy spawn by category
  (e.g. "anti-armor mission" requires MECH or HEAVY enemies)

---

## 6. Multi-tag matching: MAX rule

Decided 2026-04-29 (open-questions §3 / N12 follow-on).

When a unit carries multiple tags that match parallel meta-upgrade
tracks (e.g. `[INFANTRY, HEAVY]`), **take the maximum level** across
the matching tags rather than summing. Rationale: cumulative reductions
across 2+ tracks let reactions one-shot anything via the dice-with-
reduced-thresholds mechanism, breaking the 3-stage damage ladder.

The helper `findHighestLevelByTag(unit, levels)` implements this rule
once; all consumers should call it rather than doing their own scan.

---

## 7. Tag-count guideline (informational)

No engine cap. Design self-discipline: **3–4 tags per unit max**:

- 0–2 ability tags (OFFICER, STALWART, ARMOR:1, etc.)
- 1–2 category tags (INFANTRY + HEAVY for a heavy gunner; just INFANTRY
  for a regular trooper)

Above 4 the UI display gets crowded and rule interactions become hard
to reason about. The trait editor has no per-unit tag cap; trust the
designer.

---

## 8. Adding a new tag

1. Pick id (UPPER_SNAKE_CASE).
2. Add entry to `TRAITS` in `src/core/traits/registry.ts`. Set `kind:
   'category'` for pure classifications; omit for abilities.
3. If the tag carries an integer parameter, write its description with
   the param notation explicit (`'ARMOR:N'`).
4. (Ability only) declare the relevant flag on `TraitDef` if a new
   behavior shape is needed.
5. Update the table in §3 of this doc.
6. Add the tag to existing unit JSONs that should carry it (see
   `src/config/units/*.json`).

The engine will not need any changes for category tags — they are
read by external systems (combat-intel meta, scenario gates) by id
lookup.
