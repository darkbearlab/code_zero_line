# Brief for Claude.ai chat — Code: Zero Line project

> **Purpose of this file:** drop this into a Claude.ai web chat as the
> opening message so it's caught up on the project in one read.
> Pair it with these two files (paste their contents into the same chat,
> since web Claude can't browse the repo):
>   - `docs/roguelite-design-summary.md` — the design as it currently stands
>   - `docs/open-questions.md` — what's been decided, what's still open
>   - `docs/implementation-roadmap.md` — the 5-week build plan (if relevant)
>
> Everything below is current as of the last commit on `main`.

---

## What this project is

**Code: Zero Line** — a tactical skirmish game adapted from the user's
self-designed tabletop rulebook (v1.5; symmetric two-player squad combat
with cover, reactions, command activations, traits).

The web build runs in the browser via Phaser 3 + TypeScript + Vite, with a
strict separation between a pure-functional `core/` (rules, state, RNG,
geometry) and a `presentation/` layer (Phaser scenes, DOM HUD).

Repo: github.com/darkbearlab/code_zero_line

---

## Project direction (decided, not under debate)

**The game is being built as a single-player roguelite, NOT competitive
PvP.** The pivot is final; design effort is now spent on roguelite-shape
questions, not on whether to PvP.

Core fantasy: **the player is a commander airdropped to the front line,
taking over a pre-formed squad in one of many simultaneous attacks on a
fortified target.** Squad death per run, but the wider invasion campaign
continues with fresh squads from a persistent pool.

Three game loops nested:

```
Campaign  — whole game; ends when finale battle is won
Round     — pick 1 mission of 3-5 offered; others resolved by dice
Run       — the picked mission, possibly multi-stage with a final stage
Mission   — one BattleScene fight
```

Three currencies (Combat Intel / Area Intel / Honor) drive a meta
progression with veteran units, pool upgrades, and an unlock tree.

---

## What's already built (don't propose re-building these)

Game engine:
- Free-2D space (no grid). Polygon terrain, circular unit bases.
- Deterministic sfc32 RNG, replay-from-seed.
- Reducer pattern: every state mutation goes through `applyCommand`.
  Commands: MOVE / SHOOT / RALLY / VAULT / CLIMB / CRAWL /
  COMMAND_MOVE / COMMAND_RALLY / activations.
- Cover, prone, low/high walls, difficult terrain (rubble), soft cover
  (smoke), reaction-fire windows.
- Traits implemented: OFFICER, STALWART, FRAGILE, ARMOR(N),
  CUMBERSOME, TOUGH, STEALTH. Stubs remaining: CANNON_FODDER,
  FANATIC, IMPULSIVE, AGITATOR, WARLORD, MARTYRDOM (mostly Red
  faction flavour).

UI / tooling:
- Phaser scenes: Roster pick → Initiative roll → Deploy → Battle →
  Result. Hot-seat 2-player works today.
- Map editor (different entry: editor.html). Tools for low/high walls,
  difficult/soft terrain, A/B deployment zones, 1-UD objective circle.
- Editor weapons / units / maps export-import as JSON (per-tab and a
  bundle file).
- Replay viewer.

Headless infrastructure:
- `npm run sim` — drives N matches between two AI controllers, prints
  KPI table, writes per-match JSON to logs/. Used for AI iteration.
  Will become PvE balance regression in roguelite mode.
- `npm run probe` — A↔B traversal connectivity test (grid A*).

AI:
- `greedy` (1-ply) and `lookahead` (depth-2 beam-6 with scoring
  evaluator).
- Uses pathfinding (doesn't get stuck on walls), EV-gated reactions
  (doesn't waste shots), cover-aware, formation-aware.
- Generates COMMAND_MOVE / COMMAND_RALLY when officer + allies are
  in formation.

Scenarios already implemented:
- `elimination` (wipe enemy)
- `engage-reach` (control objective + ≥ 1 enemy killed)

Roguelite scenes / systems planned but **not yet built** (live in the
implementation roadmap):
- Campaign / Round / Run state machines + scenes
- Pool persistence, veteran tracking
- Three-currency economy
- Hub between missions
- Skill system (run-completion award, random pick, can grant stats or
  traits)

---

## Major roguelite design decisions already made

Confirmed and not up for debate (refer the user to the design summary
if they raise these):

- **Run shape**: pick 1 mission per round; that mission may be
  multi-stage; between stages a Hub offers 3-choice boons (run-only,
  not meta-persistent — explicitly NOT carried into the pool).
- **Hub framing**: "squad members reporting in to the off-site
  commander" — solves the "the gods know your future" weirdness from
  Hades-style choice menus.
- **Death**: differentiated. Run-completed = full rewards. Wiped but
  with stage wins = some intel only. Wiped early = nothing. Honor and
  exploration progress only flow from completed runs.
- **Pool**: player does NOT compose squads. Each run gets a slot-based
  random draft from the persistent pool. Slot count has RNG; honor
  upgrades raise the floor.
- **Veteran tracking**: each unit accumulates sortie count. Auto-grows
  to quality 3+. Beyond that requires earning skills.
- **Skill system**: 1 skill per completed run, awarded to a random
  survivor of that run. Skill itself is randomly drawn. Skills can
  be raw stat tweaks (+1 die / threshold -1) OR trait grants (STEALTH,
  TOUGH, OFFICER promotion). Skills have a `category` field; if the
  draw conflicts with an existing skill of the same category, reroll.
- **Tutorial**: opening run is "scout team breaks out to HQ" — almost
  guaranteed win, those units do NOT join the pool, they're a
  one-shot framing device.
- **Finale unlock**: terminal upgrade item (bought with Combat Intel)
  + EITHER all main regions occupied OR a Combat Intel speedrun
  payment. Speedrun price calibrated to be a net loss vs grinding
  there normally — exists for RTS speedrunners only.
- **Finale itself**: standalone scene, not part of a round. No other
  missions resolve in parallel ("radio silence"). 1 long mission.
  No skill / sacrifice / intel rewards. Win → campaign over → score
  screen.
- **Multiplayer**: hot-seat unlocks after first run completed.
- **Narrative**: light. Hooks established (breakout opening, Hub
  conversations, round resolution casualty reports, veteran sortie
  counts, radio-silent finale) — no dialogue / characters being added.

---

## What might still be open (worth discussing)

The user is past the major design pivots. Remaining live questions
tend to be tuning / numerical:

- Slot count range (basic, post-honor-upgrade max)
- Attack-intensity × attack-depth granularity (how many tiers each)
- Veteran growth rate (how many sorties per +1 quality)
- Skill list itself (12-15 skills proposed for v1, contents TBD)
- Mission-by-region final-stage type weighting
- Score table fields

Most of these are **"defer to sim stage"** decisions — they expect to
play 20+ runs, watch the data, then tune. Don't push them to commit
to numbers prematurely.

---

## What kind of help the user wants from this chat

Almost certainly **design discussion / second opinion / brainstorm**.
You can't run code; that's their IDE Claude session.

Useful modes:
- Push back on design choices that seem off (emotional engine logic,
  pacing, retention curves)
- Suggest skill ideas / mission archetypes / hook moments they
  haven't thought of
- Comparable-game references (XCOM, Hades, Into the Breach, Slay the
  Spire, FTL, Darkest Dungeon, Battle Brothers, Wargroove, Frostpunk)
- Critique the implementation roadmap if the user shares it
- Talk through narrative beats / score table shape / trailer pitch

Less useful modes:
- Writing TypeScript / Phaser code (their IDE Claude does that)
- Re-architecting things in "What's already built"
- Suggesting they revisit settled design decisions

---

## Style notes for working with this user

- Native Mandarin Chinese; will write in Chinese, can read English.
  Match the language they write.
- Engineer mindset. Terse. Hates filler ("certainly!", "I'd be happy
  to…"). Substance first sentence.
- Always wants concrete trade-offs and a recommendation. When listing
  options, put your pick first and label it. "It depends" is not an
  acceptable answer.
- Skeptical of over-engineering. Justify any complex proposal.
- Numbers / specifics > vague platitudes. "Hub uses 3-choice with
  weighted draws" beats "the Hub should feel rewarding".

---

## How to start

After they paste the supporting docs:

1. If they ask a specific question, answer in trade-off format with a
   recommendation.
2. If they say "discuss" or similar, pick the most interesting open
   numerical / tuning question from the live list above and propose
   3 options + your pick + reason.
3. If they share the implementation roadmap and want feedback, focus
   on what's missing or what's sequenced wrong, not on the obvious.

Don't dump everything in one reply. One tight argument > a sprawling
audit.
