# Code: Zero Line — Roguelite Design Discussion

> **Status: discussion document.**
> Use this file to think out the next phase of the project. Sections marked
> **🟡 Open question** need a decision before we write code. Sections marked
> **💬 Claude's take** are recommendations — push back freely.
> When you're done editing, ping me to re-read.

---

## 1. The pivot, in one paragraph

Drop competitive PvP from the roadmap. Build the game as a **single-player
roguelite** where each run is one squad in a larger invasion campaign.
A squad attacks for 3 missions; if they all live, run wins; if any die, the
squad is gone but the campaign continues with a fresh squad in the next run.
Meta progression = damage to the invasion target across all squads.

Keeps almost everything we've already built (deterministic core, AI,
geometry, editor, sim) and unlocks design freedom (skill diversity matters
more than balance).

---

## 2. Why this works (the strong points)

The "multi-squad simultaneous invasion" frame resolves three classic
roguelite tensions:

| Tension | Usual fix | Your fix |
|---|---|---|
| Death must hurt vs. death must not stop play | Partial progress kept on death | Squad death is total, but the invasion war is not |
| Each run a new character vs. narrative continuity | Reincarnation / time-loop trope | "Another squad is pushing on another vector" — physically coherent |
| Why am I fighting the same boss again | Multi-phase boss fights, escalation | Multi-vector attack, different terrain / objective each time |

Comparable: XCOM 2 resistance cells, Battle Brothers contracts,
Darkest Dungeon expedition parties. **The "many squads attacking one giant
target" angle is fresh.**

The "potentially endless campaign + far-future cross-run consequences"
arrangement is good. Don't solve it now; design today should leave room.

---

## 3. Three design tensions to resolve before coding

### 3.1 Run-internal player agency

A run is 3 missions. If those 3 missions are just back-to-back fights, you
miss the hallmark of the genre — the moment-to-moment decisions inside one
run (Hades boon, StS card pick, FTL store).

**💬 Claude's take:** insert a **between-mission Hub** between each fight:

```
[Start → Mission 1 → Hub → Mission 2 → Hub → Mission 3 → Result]
```

Hub presents 3 cards. Each card type works:
- **Supply** (recruit / weapon / heal a wounded unit)
- **Intel** (next mission has +cover / -1 enemy / +reward)
- **Risk** (harder mission, bigger reward)

Without this layer, "3 missions" is just three fights and the run lacks an
arc.

🟡 **Open question 3.1:** are you happy with the Hub-between-missions
structure?

- [ ] Yes, do it
- [ ] No — alternative shape: _______________
- [ ] Defer (ship without Hub, add later if it feels flat)

---

### 3.2 Meta progression visibility

"Invasion progress" needs a concrete scoreboard the player can SEE
advancing. Otherwise 50 runs feel the same as 1.

Layered options (mix-and-match):

| Layer | Example | Motivation strength |
|---|---|---|
| Pure numbers | Total wins / kills / currency | weak |
| **Unlock library** | New units, weapons, traits enter the pool | **strong** — every run has different choices |
| **Permanent enemy damage** | "Cannon #3 is out" → certain mission types easier or removed | **strong** — directly fits your invasion frame |
| Vector progress | "East flank 60%, West flank 20%" — different vectors offer different mission types | medium — adds run-to-run choice |
| Endgame trigger | "Core reactor exposed" → next successful run can run a finale mission | strong — gives an *optional* end point |

**💬 Claude's take:** ship 1 + 2 + 3 in v1; add 4 + 5 later.

The "endgame trigger" is worth including even if you said the campaign is
endless — it lets you play once for closure but resets and continues
forever for grinders. Hades does this; it's why it works for both player
types.

🟡 **Open question 3.2:** which layers go into v1?

- [ ] 1 + 2 + 3 (Claude's suggestion)
- [ ] 1 + 2 only (defer permanent enemy damage)
- [ ] 1 + 2 + 3 + 5 (also include an endgame trigger from day 1)
- [ ] Other: _______________

---

### 3.3 Mission type variety

Three "go to the objective" missions would feel like one mission times
three. Need 3-5 mission types from day 1.

| Mission type | Win condition | Engine readiness |
|---|---|---|
| Capture | Control objective + ≥ 1 kill | ✅ Done (engage-reach) |
| Elimination | Wipe enemy | ✅ Done |
| Defend | Hold a point N rounds without enemy entering | 🟡 Reverse engage-reach |
| Extract | Get specific units to map edge | 🟠 New scenario, easy |
| Assassinate | Kill an enemy VIP that tries to flee | 🟠 New: VIP flag + flee AI |
| Sabotage | Destroy N objects then extract | 🔴 New: destructible terrain / HP |

**💬 Claude's take:** ship the first 5 in v1 (sabotage later). Each run
draws 3 from this pool, possibly with repeats allowed but the third
(final) mission tends toward harder types.

🟡 **Open question 3.3:** which mission types make v1?

- [ ] First 5 (Capture, Elimination, Defend, Extract, Assassinate)
- [ ] First 4 (skip Assassinate — VIP behaviour can wait)
- [ ] Just Capture + Elimination + Defend (cheaper start)
- [ ] Other: _______________

---

## 4. Minimum viable shape (v1)

```
TitleScene
  ↓ [New Run]
RunSetupScene
  - Pick 3–4 units from currently-unlocked pool
  - Show invasion progress bar(s)
  ↓
MissionScene #1 (random mission type from pool)
  ↓ [survived]
HubScene #1 (3-choice reward)
  ↓
MissionScene #2
  ↓
HubScene #2
  ↓
MissionScene #3 (harder — "final mission" of the run)
  ↓
RunResultScene
  - Tally: rewards, currency, permanent progress
MetaScene (browse anytime)
  - Unlocks, currency, progress, run history
```

**Minimum content for v1:**
- 5 mission types
- 4–6 unit templates available at start
- 3 progression "tiers" of unlocks
- 1–2 maps per mission type (procgen variations on top)

That's it. Ship this and play 20 runs. Refine from there.

---

## 5. Architecture (no branch needed)

Add new directories — nothing existing changes:

```
src/
  campaign/      ← persistent meta state
    state.ts        CampaignState + localStorage
    progress.ts     unlocks, milestones
    rewards.ts      run-end → currency / unlocks
  missions/      ← mission types + generators
    types.ts        MissionDef interface
    generators/     procgen for each mission type
    library.ts      hand-crafted missions (tutorial, finale)
  runs/          ← in-run state machine
    state.ts        RunState (squad, missionIdx, accumulated rewards)
  presentation/scenes/
    TitleScene.ts (new)
    RunSetupScene.ts (new)
    HubScene.ts (new — between-mission choices)
    RunResultScene.ts (new)
    MetaScene.ts (new)
    BattleScene.ts ← unchanged, takes a MissionDef
```

**Key invariants this preserves:**
- BattleScene already accepts an `initialState`. Generators produce that.
- Scenario modes are already a discrim union; we just add new ones.
- Sim CLI becomes a difficulty/balance regression tool: "100 runs,
  default squad, default AI — what's the win rate per mission type?"
  PvP mode never had this; PvE mode does.
- Editor still works for hand-crafted maps.

**PvP doesn't disappear; it just isn't built.** A future `Net` scene
adapter can layer on top later if anyone ever wants it.

---

## 6. Open questions (decisions needed before code)

### 🟡 Open question 6.1: Squad size

Affects mission scale, balance, choice depth in RunSetup.

- [ ] 3 (very tight, every unit decision matters)
- [ ] 4 (Claude's lean — close to "fireteam", manageable depth)
- [ ] 6 (more variety per run, slower individual decisions)
- [ ] Variable: meta-unlocks raise cap from 3 to 6
- [ ] Other: _______________

### 🟡 Open question 6.2: Squad composition

- [ ] Fully player-picked from unlocked pool
- [ ] Forced commander + player picks the rest
- [ ] Forced one of each role (officer / specialist / regular …)
- [ ] Other: _______________

### 🟡 Open question 6.3: Death penalty severity

Run failure (squad wipe) means…

- [ ] Soft: keep 50% of currency earned this run
- [ ] Medium: keep 20% (Claude's lean for genre conventions)
- [ ] Hard: 0 currency, but milestone progress (unlocks) stays
- [ ] Hard + permadeath of unit slots already unlocked? (very harsh)
- [ ] Other: _______________

### 🟡 Open question 6.4: First-run experience

- [ ] First run is a guaranteed-winnable tutorial (XCOM-style)
- [ ] First run is normal difficulty (StS-style — early wipes are part of the loop)
- [ ] First run is normal but with extra in-run hints
- [ ] Other: _______________

### 🟡 Open question 6.5: Local multiplayer unlock

Currently working in BattleScene as hot-seat.

- [ ] Always available from main menu
- [ ] Locked until N campaign wins
- [ ] Locked until campaign finale completed once
- [ ] Available from start, but campaign-related unlocks (units / maps) flow into MP gradually
- [ ] Other: _______________

### 🟡 Open question 6.6: Run length target

- [ ] 10 minutes (3 quick missions)
- [ ] 15–20 minutes (Claude's lean — fits the "fireteam ops" feel)
- [ ] 30 minutes
- [ ] Variable per mission type (e.g. extract is shorter than defend)
- [ ] Other: _______________

### 🟡 Open question 6.7: Narrative framing strength

- [ ] Heavy narrative — text scenes between missions, characters with names, dialogue
- [ ] Light narrative — mission briefings + post-mission summaries (Claude's lean for v1)
- [ ] Pure mechanics — no story scaffolding, mission objectives only
- [ ] Other: _______________

### 🟡 Open question 6.8: Multiple invasion vectors

The "east flank / west flank" framing — when does it show up?

- [ ] v1 — pick a vector at run start; different vectors → different mission pools
- [ ] v2 — single vector first, multi-vector later
- [ ] Never — single linear invasion is fine
- [ ] Other: _______________

---

## 7. Things explicitly **not** decided here

These are deliberate non-decisions for now — no need to answer:

- Cross-run consequences ("we damaged the super-mech permanently"). Far future.
- Visual / audio direction. Doorbreaker-like top-down stays the assumption.
- Monetization / distribution platform. Not relevant to engineering yet.
- Endgame final-boss specifics. We need to play 20 runs first to know what
  feels climactic.
- Whether to support modding via the editor → distribution path. Editor
  already exists; whether we promote it as moddable later is a marketing
  call.

---

## 8. Once decisions land

I'll convert this doc into:

1. A 4-week implementation plan (concrete file-by-file)
2. A first vertical slice: title → run setup → 1 mission → result, just to
   prove the loop
3. Sim regression scenarios for each mission type (so balance can be tuned
   headlessly)

But first — fill in the 🟡 Open questions when you're ready, push, and ping me.
