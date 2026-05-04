# Roguelite implementation roadmap

> 5-phase build plan. Each phase ends in a **playable artifact** so we
> can stop and reassess. No phase blocks on the next one — if Phase 3
> reveals the round structure feels wrong, we re-plan from there.
>
> Source decisions: `docs/roguelite-design-summary.md` +
> `docs/open-questions.md`.

---

## Sequencing principle

Vertical slice early. **Phase 1 must produce a runnable end-to-end
loop** even if everything inside it is fake / fixed. Polish, content,
and balance tune later. We've seen with the AI work that real signal
needs the loop closed.

The order is built around "what's necessary to validate the design".
Skills, finale, and multiplayer come last because they're additive —
the fundamental loop is missions chained into runs chained into rounds.

---

## Phase 1 — Vertical slice (1 week)

**Goal:** title → start → 1 run with 3 fake missions and Hub between
them → result screen. No campaign layer yet, no pool, no economy.

**Build:**

| File | Purpose |
|---|---|
| `src/runs/state.ts` | `RunState`: squad, missionIndex, missionsTotal, accumulated boons, startedAt |
| `src/missions/types.ts` | `MissionDef` interface — mapId, scenarioMode, enemy spawn config |
| `src/missions/library.ts` | 3 hand-crafted mission defs for Phase 1 (all `engage-reach` for now) |
| `src/presentation/scenes/TitleScene.ts` | "New Run" button, MetaScene placeholder, Multiplayer (locked) |
| `src/presentation/scenes/RunSetupScene.ts` | Shows fixed squad (drafted from a hardcoded pool), shows the 3 mission slugs upcoming, "Begin Run" |
| `src/presentation/scenes/HubScene.ts` | 3 cards: 1 stat boon / 1 free heal / 1 risk-reward. Player picks 1. Boons apply only this run. |
| `src/presentation/scenes/RunResultScene.ts` | Win / loss summary, sortie counts, "Return to Title" |

**BattleScene changes:** accept `{ initialState, runContext }` so it
knows to return to HubScene / RunResultScene instead of the
hot-seat ResultScene. Nothing else changes in core/.

**Cuts:**
- No Round layer (player goes straight from Title → Run → Result)
- No mission generators (just 3 hand-picked configs)
- No pool persistence (squad is hardcoded fresh each run)
- No currencies, no upgrades, no skills, no veterans

**Done = playable when:** start a run, fight 3 fights with Hub
between, see whether you won, click back to title. Every choice is
fake — it's just the loop.

---

## Phase 2 — Mission variety (1 week)

**Goal:** each run feels different from the last because mission
types differ.

**Build:**

| File | Purpose |
|---|---|
| `src/missions/generators/capture.ts` | Wraps `engage-reach` |
| `src/missions/generators/elimination.ts` | Wraps `elimination` |
| `src/missions/generators/defend.ts` | New scenario: hold a point N rounds without enemy entering objective |
| `src/missions/generators/extract.ts` | New scenario: get N units to a marker before round limit |
| `src/missions/generators/assassinate.ts` | New scenario: kill an enemy VIP that flees |
| `src/core/scenario/defend.ts` | New `defend` ScenarioMode in core |
| `src/core/scenario/extract.ts` | New `extract` ScenarioMode |
| `src/core/scenario/assassinate.ts` | VIP flee AI behaviour + win condition |
| `src/missions/pick.ts` | Random draw of 3 mission types per run, weighted by region (region context faked in this phase) |

**Run shape:** Phase 1's 3 hand-picked missions become "draw 3 of 5
types randomly".

**Sim regression:** add a CLI mode `npm run sim:missions` that runs
each mission type 50× with default squad/AI and prints win rates per
type. The numbers tell us if any mission type is broken before we
keep building.

**Done = playable when:** runs feel distinct because the 3 missions
aren't the same shape every time.

---

## Phase 3 — Campaign + Round + Pool (1 week)

**Goal:** the loop closes. Not just "do a run", but "do many runs and
the world remembers".

**Build:**

| File | Purpose |
|---|---|
| `src/campaign/state.ts` | `CampaignState`: regions[], pool, currencies, milestones |
| `src/campaign/persist.ts` | localStorage I/O, save key `czl.campaign.v1` |
| `src/campaign/regions.ts` | Region structure (id, name, stage: breakthrough/beachhead/occupied) |
| `src/rounds/state.ts` | `RoundState`: missions offered, missions assigned squads, picked mission |
| `src/rounds/pick.ts` | Round draws 3-5 missions across active regions, allocates pool members to each |
| `src/rounds/resolve.ts` | After player's run ends, dice the unpicked missions. fuzzy-success-rate → hidden range → seeded RNG outcome. casualties / survivors update pool |
| `src/missions/economy.ts` | `任務基底情報 × 強度倍率 × 70/30%` formulas (data-driven via JSON) |
| `src/presentation/scenes/RoundSetupScene.ts` | Mission menu: cards showing slug + assigned squad + fuzzy success rate + region. Click 1 to commit |
| `src/presentation/scenes/RoundResolveScene.ts` | Sequential reveal of unpicked missions: ✓ / ✗ + casualty list (sorties highlighted on veterans). Skippable |
| `src/presentation/scenes/MetaScene.ts` | Currencies, regions list, pool browser (sortie count visible) |
| `src/missions/tutorial.ts` | Opening "scout breakout" mission (force-favourable, units don't join pool) |

**Tutorial flow:** TitleScene → if `state.tutorialCompleted === false`,
launch breakout. After breakout, push player into normal Round 1.

**Pool initialization:** on tutorial-complete, spawn 12 starter units
into the pool (hardcoded template mix for now). Each round adds /
removes from there.

**Cuts kept:**
- No skills yet
- No honor / pool upgrades yet (all currencies earn but don't spend
  on anything visible — placeholder upgrade tree)
- No finale, no exploration topology UI (regions are just list rows)

**Done = playable when:** start campaign → tutorial → 5 rounds in a
row → see your pool shrink/grow → pick missions and feel the
"abandoning a mission means those people die" weight.

---

## Phase 4 — Skills + Veteran growth + Honor economy (1 week)

**Goal:** the meta progression curves materialize. Veterans become
visible, distinct units, not interchangeable.

**Build:**

| File | Purpose |
|---|---|
| `src/skills/types.ts` | `SkillDef`: id, displayName, category, effect (stat / trait / hook) |
| `src/skills/registry.ts` | 12-15 skill definitions for v1 |
| `src/skills/award.ts` | Run-complete hook: pick 1 random survivor, draw 1 random skill, reroll if same-category conflict, apply |
| `src/skills/apply.ts` | Translate skill effect into `Unit` mutations (stat tweaks, trait additions) |
| `src/core/state/GameState.ts` | `Unit` gains `acquiredTraits?: string[]` and `acquiredSkills?: string[]` (separate from template `traits`) |
| `src/campaign/upgrades.ts` | Honor-spend tree: pool quality strength, weapon tier, slot count bias, success-rate buffs |
| `src/presentation/scenes/UpgradeScene.ts` | Honor upgrade tree UI |
| `src/presentation/scenes/RoundResolveScene.ts` | Extended: "Sgt. Vance gained skill: Steady Aim" reveal step |
| `src/presentation/scenes/MetaScene.ts` | Pool entries show acquired skills, sortie count, "曾跟隨指揮官 N 次" highlight |

**Sortie tracking:** every time a unit is on a mission (any
disposition), `unit.sorties += 1`. Auto-quality-up at thresholds
(3 → 2 sorties? to be sim-tuned). Cap = 3+ from auto growth; 2+
requires a `+quality` skill.

**Skill v1 list (proposal — final list at sim time):**

Stat skills (8):
1. `STEADY_AIM` — threshold -1
2. `EXTRA_DICE` — +1 die on attack
3. `RAPID_RECOVERY` — auto-pass first rally per match
4. `MOBILITY` — +0.5 UD movement
5. `EXTRA_REACTION` — +1 die on reaction shots
6. `HARDENED` — opponent's cover bonus reduced by 1 against this unit
7. `QUARTERMASTER` — +1 sortie counted per mission (faster veteran)
8. `RESILIENT` — first wound this run is downgraded one step

Trait skills (4):
9. `+STEALTH`
10. `+TOUGH`
11. `+OFFICER` (promotion — only legal if not already officer)
12. `+STALWART`

Reroll-if-conflict cases:
- 1 vs 5 (both touch ranged accuracy → category `ranged-buff`)
- 9-12 mutual exclusion if unit already has the trait
- 7 vs sortie-rate skill (only one veteran-rate buff at a time)

**Sim regression:** add `npm run sim:campaign` that simulates a
100-round campaign with default AI, reports veteran emergence,
casualty rate, currency curve. Wins or loses → tells us if the meta
curve is too flat or too steep.

**Done = playable when:** veterans visibly distinguish themselves;
the upgrade tree matters; the campaign progresses meaningfully over
many rounds.

---

## Phase 5 — Finale + topology + polish (1 week)

**Goal:** campaign can end. Score table exists. Multiplayer unlock
works. Edges are smoothed.

**Build:**

| File | Purpose |
|---|---|
| `src/campaign/finale.ts` | Finale unlock check (terminal upgrade purchased + all-regions-occupied OR speedrun fee paid) |
| `src/missions/finale.ts` | Finale mission def — single long fight, no rewards, win-on-clear |
| `src/presentation/scenes/FinaleScene.ts` | Pre-finale briefing scene + radio-silent intro |
| `src/presentation/scenes/ScoreScene.ts` | Slay-the-Spire-style end-of-campaign tally, screenshot-friendly |
| `src/presentation/scenes/CampaignMapScene.ts` | List view of regions and stages (per design: list first, prettier UI later) |
| `src/multiplayer/unlock.ts` | Track first-run-complete flag; gate `MultiplayerScene` link on TitleScene |
| `src/missions/objectives.ts` | Final-stage objective preview UI (where applicable) — stage 3 of a run shows its objective on RunSetupScene |
| `src/missions/swap.ts` | Specialised final-stage swap: swap 1-2 pool slots for compatible specialists |

**Polish items (each ~half day):**
- Round resolution dramatic pacing (animated reveal, casualty SFX, music swell on veteran death)
- Hub conversation framing (squad member reports a flavour line per boon card)
- Pool browser sort/filter (by sortie count, by traits, by acquired skills)
- Editor: export the current pool as JSON for sharing / debugging
- DeployScene shows objective marker if mission has one (was deferred)

**Done = playable when:** a player can play a full campaign from
title to finale and see their score screen, AND a friend can sit on
the same machine to play multiplayer once the unlock fires.

---

## After Phase 5 — what's left

These don't block shipping but are the obvious continuations:

- 6 stub traits (CANNON_FODDER, FANATIC, IMPULSIVE, AGITATOR,
  WARLORD, MARTYRDOM) — easier to implement once faction-flavour
  decisions land
- Topology UI upgrade (list → map graph)
- Run replay viewer in-roguelite mode (already exists in core; just
  needs entry point from RunResultScene)
- Cross-run permanent enemy damage ("we wrecked their cannon")
- Daily seed challenges (sfc32 already deterministic)
- Tutorial polish (right now it's almost-guaranteed-win; could be
  staged with explicit prompts)
- Steam / itch packaging (Tauri or pure HTML5 zip)

---

## Engineering invariants this plan preserves

- **No PvP code is added or removed** — the project is purely additive
- **Core stays pure** — all new game-mode logic lives outside
  `src/core/`. The reducer never learns about runs / rounds / pools.
- **Editor stays useful** — maps it produces feed mission generators
  via `mapId` references
- **Sim harness becomes balance regression** — every phase adds at
  least one new sim CLI mode (`sim:missions`, `sim:campaign`, …)
- **Persistence is one localStorage key** (`czl.campaign.v1`) — easy
  to wipe, easy to inspect, easy to export

---

## Risk register

| Risk | Likely phase | Mitigation |
|---|---|---|
| Pool grows unboundedly | 3 | Phase 3 includes "kill rate from unpicked failures" — measure in-sim. Add soft cap if needed in 4. |
| Mission types feel same despite variety | 2 | If sim shows >70% of fights resolve via shooting only, redesign defend / extract specifically |
| Skill draw is dull because most are stat-only | 4 | Trait-grant skills (9-12) carry the "wow" weight. Make sure award reveal celebrates them. |
| Campaign is too long or too short | 4-5 | Sim regression `sim:campaign` measures rounds-to-finale; tune via region count + occupy thresholds |
| Tutorial-too-easy fails to convert | 5 | Real test only when v1 ships; keep instrumentation to count drop-off post-tutorial |
| Veteran emergence too rare to feel | 4 | Auto-growth thresholds tuned in sim; quartermaster skill exists as a knob |

---

## Out of scope for v1

These are not in the 5-week plan and shouldn't accumulate scope:

- Localisation (English / Japanese strings) — Chinese-only ship, add later
- Sound design beyond stub SFX hooks
- Animation polish beyond Phase 5 polish day
- Cross-platform packaging (Tauri / Steam)
- Save slots beyond a single campaign in localStorage
- Cloud sync
- Analytics / telemetry beyond local logs/

If any of these creep into a phase, push back to the user before
committing the time.
