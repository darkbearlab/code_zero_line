# Brief for Claude.ai chat — Code: Zero Line project

> **Purpose of this file:** drop this into a Claude.ai web chat as the
> opening message so it's caught up on the project in one read.
> Pair it with [`roguelite-design.md`](./roguelite-design.md) (paste its
> contents into the same chat, since web Claude can't browse the repo).
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

## What's already built (so don't propose re-building these)

Game engine:
- Free-2D space (no grid). Polygon terrain, circular unit bases.
- Deterministic sfc32 RNG, replay-from-seed.
- Reducer pattern: every state mutation goes through `applyCommand`.
  Commands include MOVE / SHOOT / RALLY / VAULT / CLIMB / CRAWL /
  COMMAND_MOVE (officer leads squad) / COMMAND_RALLY / activations.
- Cover, prone stance, low/high walls, difficult terrain (rubble),
  soft cover (smoke), reaction-fire windows on movement.
- Traits implemented: OFFICER, STALWART, FRAGILE, ARMOR(N),
  CUMBERSOME, TOUGH, STEALTH. Stubs remaining: CANNON_FODDER,
  FANATIC, IMPULSIVE, AGITATOR, WARLORD, MARTYRDOM (Red faction
  flavour mostly).

UI / tooling:
- Phaser scenes: Roster pick → Initiative roll → Deploy → Battle →
  Result. Hot-seat 2-player works today.
- A separate **map editor** (different entry point in editor.html):
  rectangular tools for low/high walls, difficult/soft terrain, A/B
  deployment zones, plus a 1-UD-diameter **objective** circle.
- Editor weapons / units / maps export-import as JSON (per-tab and a
  bundle file).
- Replay viewer (one-shot camera follows action).

Headless infrastructure:
- `npm run sim` — drives N matches between two AI controllers, prints
  KPI table, writes per-match JSON to logs/. Used for AI iteration.
- `npm run probe` — tests A↔B traversal on a map (grid A* with
  unit-radius inflation), prints connectivity report.

AI:
- `greedy` (1-ply heuristic) and `lookahead` (depth-2 beam-6 search
  over candidate command sequences using a scoring evaluator).
- AI uses pathfinding (so it doesn't get stuck on walls), can fire
  reactions (EV-gated so it doesn't waste shots), values cover, values
  units bunched around an officer (formation aura).
- Lookahead's candidate generators emit COMMAND_MOVE / COMMAND_RALLY
  when allies are within 1 UD of the officer — actually fires in sims
  on cluttered maps with longer matches.

Scenarios:
- `elimination` (wipe enemy) and `engage-reach` (control objective
  + ≥ 1 enemy killed). Default is `elimination`.

---

## Where the project is going (the pivot under discussion)

**Drop competitive PvP. Build it as a single-player roguelite.**

User's framing: each run is one squad in a multi-vector invasion of a
fortified target. 3 missions per run. Squad death is total per run, but
the campaign continues with fresh squads. Meta progression = invasion
damage. Run length 10–30 minutes. Run-reset model (no unit carryover).
Local hot-seat multiplayer kept as an unlock/side mode.

Why:
- Engine already 80% suitable (deterministic core, AI, sim, editor)
- No PvP scaffolding written yet — pivot is purely additive, no
  rollback / branch needed
- Removes balance/server/anti-cheat burden
- AI investment becomes the core product (PvP doesn't even need AI)
- The "many simultaneous squads" frame is fresh in the genre

**The full design discussion lives in `docs/roguelite-design.md`** —
ask the user to paste it after this brief.

---

## What's currently being decided (8 open questions)

User is chewing on the open-question section of the design doc. Active
choices include:

- Squad size (3 / 4 / 6 / variable)
- Squad composition (free pick / forced commander / role-balanced)
- Death penalty severity (soft 50% / medium 20% / hard 0% currency)
- First-run guaranteed-winnable tutorial vs normal difficulty
- Local multiplayer always-on vs unlock-gated
- Run length target
- Narrative framing strength (heavy / light / pure mechanics)
- When invasion vectors (east flank / west flank) become a feature

If the user is asking you about any of these, give them a structured
opinion with trade-offs, not a flat answer. They've got an engineer's
mindset and respond well to "here are the three options + which I'd
pick + why".

---

## What kind of help the user wants from this chat

Probably **design discussion / second-opinion**, not implementation
(you can't run code; that's what their other Claude session in their
IDE is for).

Useful modes:
- Push back on design choices that seem off
- Point out roguelite-genre conventions they might not know
- Talk through the trade-offs of the 8 open questions
- Suggest things they haven't considered (mission types, meta
  unlock structures, narrative beats, replay value tricks)
- Comparable-game references (XCOM, Hades, Slay the Spire, FTL,
  Battle Brothers, Into the Breach, Wargroove, etc.)

Less useful modes:
- Writing TypeScript / Phaser code (handled in their IDE)
- Re-architecting things that already exist (see "What's already built")
- Generic advice ("you should test it!" — they have a sim harness)

---

## Style notes for working with this user

- Native Mandarin Chinese speaker. Will write in Chinese; happy to
  read English. Either language is fine to reply in — match what
  they write.
- Engineer mindset, terse, no-fluff. Hates filler ("certainly!",
  "I'd be happy to…"). Get to the substance.
- Wants concrete trade-offs and recommendations, not "it depends".
  When listing options, put the one you'd pick first and label it.
- Skeptical of over-engineering and premature abstraction. If you
  propose something complex, justify the complexity.
- Will commit / push frequently from their IDE Claude session.
  Doesn't need you to write code blocks longer than illustrative
  snippets.

---

## How to start

Read the design doc the user pastes next. Then either:

1. If they ask a specific question, answer it with the trade-offs
   format above.
2. If they say "discuss", pick one of the 8 open questions you have
   the strongest opinion on, lay out the options, recommend one, and
   ask them to push back.

Don't try to cover everything at once. They'd rather have one tight
conversation than a sprawling overview.
