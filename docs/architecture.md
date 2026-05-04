# 架構速查

> 目標:任何「這功能在哪?」的問題在 2 分鐘內找到檔案。
> 系統意圖請看 [roguelite-design-summary.md](roguelite-design-summary.md);本文只描述當前程式碼結構。

---

## 目錄樹(src/ 第一層)

| 目錄 | 職責 | 注意 |
|---|---|---|
| [core/](../src/core/) | 規則引擎:command reducer、戰鬥解算、LOS / geometry、RNG、trait registry、replay log。**完全不知道 campaign / run / round 概念**。 | 純函數;任何 mutation 走 `applyCommand` |
| [ai/](../src/ai/) | AI controller(`greedy`、`lookahead`)、scenario 評估、reaction planning、grid pathfinder | 只讀 GameState,不寫 |
| [missions/](../src/missions/) | MissionDef 註冊與篩選(`includeInCampaignPool` flag)、bundled + custom 合併 | 任務 JSON 在 `src/config/missions/` |
| [operations/](../src/operations/) | **多階段任務鏈**:OperationDef schema、picker(綁具體 mission id)、registry。Bundled 5 個 op,難度 1-5。 | OperationInstance = picker 產出,塞進 RunState |
| [rounds/](../src/rounds/) | 戰役回合層:抽出 N 個 OperationInstance、squad draft、未選 option 的 fuzzy auto-resolve | round 不持久化(每次 RoundSetup 重抽) |
| [runs/](../src/runs/) | Run 狀態機:operation chain 推進、bankedRewards 累積、retreat、boon 套用、persist 到 `czl.run.v1` | RunState 透過 saveRun 隨時可恢復 |
| [campaign/](../src/campaign/) | 持久 meta state:pool、currencies、upgrades、recruit 補員、veteran sortie 計數;persist 到 `czl.campaign.v1` | `advanceCampaignAfterRun` 是唯一寫入點 |
| [sim/](../src/sim/) | Headless CLI:`npm run sim` 跑批量對戰收 KPI、`npm run probe` 跑 A↔B 連通性測試 | 用於 AI / 平衡迴歸 |
| [config/](../src/config/) | Bundled JSON(missions、operations、units、weapons、factions、maps);`bundles.gen.ts` 是 codegen 產物 | **不要手改 bundles.gen.ts** — 由 `npm run gen-bundles` 產生 |
| [editor/](../src/editor/) | 瀏覽器內編輯器(`editor.html` 入口):weapons / units / factions / maps / missions / operations 6 個分頁,寫入 localStorage `czl.editor.*.v1` | Vite plugin 提供 save-to-bundle endpoint(僅 dev) |
| [presentation/](../src/presentation/) | Phaser scene 生命週期、地形 / 視野 / HUD 渲染。15 個 scene。 | scene 之間透過 init data 傳狀態 |

---

## Phaser scene 流程圖

```
TitleScene
   │
   ├─ [▶ New Campaign / Continue Campaign]
   │      │
   │      ▼
   │  RoundSetupScene ──[選 1 個 operation card]──▶ commitOption(saveRun)
   │      │                                                │
   │      │                                                ▼
   │      │                                          BattleScene
   │      │                                                │
   │      │                                                ▼
   │      │                                          ResultScene
   │      │                                                │
   │      │                                  ┌─────────────┴───────────────┐
   │      │                                  │ 還有下一階段                 │ 鏈條結束 / 全滅
   │      │                                  ▼                              ▼
   │      │                              HubScene ──[boon 選擇]─▶ Battle  RunResultScene
   │      │                                  │     ──[Retreat]──▶ RunResult     │
   │      │                                  ▼                                  ▼
   │      │                            (回 BattleScene)                advanceCampaignAfterRun
   │      │                                                                     │
   │      │                                                                     ▼
   │      │                                                            RoundResolveScene
   │      │                                                                     │
   │      │                                                                     ▼
   │      │                                                              [回 RoundSetup]
   │      │
   │      ├─ [指揮部] ─▶ MetaScene(池子 / 貨幣 / 老兵瀏覽)
   │      └─ [升級樹] ─▶ UpgradeScene(花榮譽強化)
   │
   ├─ [▶ Resume Operation] ─▶ Hub or RunResult(視 RunState 狀態而定)
   ├─ [3-Mission Run (legacy)] ─▶ RunSetupScene(沙盒 3 任務 run)
   └─ [Battle Sandbox (1v1)] ─▶ RosterScene ─▶ InitiativeRoll ─▶ DeployScene ─▶ BattleScene ─▶ ResultScene ─▶ ReplayScene
```

**沙盒路徑**(legacy / debug):RosterScene → InitiativeRollScene → DeployScene → BattleScene → ResultScene。不經過 campaign / round / run 層。

**Replay**:`czl.replay.*` 存 5 槽 ring buffer,ReplayScene 從 ResultScene 入口讀回放。

---

## 主要狀態型別與所在檔

| 型別 | 檔 | 說明 |
|---|---|---|
| `GameState` | [src/core/state/GameState.ts](../src/core/state/GameState.ts) | 戰鬥內全狀態 — units、initiative、terrain、log |
| `Command` | [src/core/commands/types.ts](../src/core/commands/types.ts) | discriminated union:MOVE / SHOOT / RALLY / VAULT / CLIMB / CRAWL / COMMAND_* / activations |
| `MissionDef` | [src/missions/types.ts](../src/missions/types.ts) | 含 `difficulty: 1..5`、`includeInCampaignPool` |
| `OperationDef` / `OperationInstance` | [src/operations/types.ts](../src/operations/types.ts) | 模板 vs 已實例化的鏈 |
| `RunState` | [src/runs/state.ts](../src/runs/state.ts) | squad、missionIds chain、bankedRewards、retreated、operation context |
| `RoundState` | [src/rounds/state.ts](../src/rounds/state.ts) | options(N 個 OperationInstance + squadIds)、seed |
| `CampaignState` | [src/campaign/state.ts](../src/campaign/state.ts) | pool、currencies、upgradeLevels、roundIndex、nextRecruitId |

---

## localStorage 鍵列表

| Key | 內容 | I/O 擁有者 |
|---|---|---|
| `czl.campaign.v1` | CampaignState 序列化 | [src/campaign/persist.ts](../src/campaign/persist.ts) |
| `czl.run.v1` | RunState 序列化(in-flight operation) | [src/runs/persist.ts](../src/runs/persist.ts) |
| `czl.replay.index` | 5-槽 replay metadata 索引 | `src/core/replay/storage.ts` |
| `czl.replay.<id>` | 個別 replay log | 同上 |
| `czl.editor.weapons.v1` | 自訂 weapon 草稿 | [src/editor/storage.ts](../src/editor/storage.ts) |
| `czl.editor.templates.v1` | 自訂 unit template | 同上 |
| `czl.editor.factions.v1` | 自訂 faction | 同上 |
| `czl.editor.maps.v1` | 自訂 map editor doc | 同上 |
| `czl.editor.missions.v1` | 自訂 mission 草稿 | [src/missions/library.ts](../src/missions/library.ts) |
| `czl.editor.operations.v1` | 自訂 operation 草稿 | [src/operations/registry.ts](../src/operations/registry.ts) |
| `czl.editor.lastTab` | 編輯器分頁記憶 | `src/editor/index.ts` |
| `czl.lastMapId` | sandbox roster 最近選的地圖 | `RosterScene` |
| `czl.logCollapsed` | HUD 戰鬥 log 收合狀態 | `Hud` |

**SSR-safe pattern**:所有 persist 檔皆以 `try { ... } catch` 包 `localStorage`,沒有瀏覽器(jsdom test)時 noop。

---

## 資料流關鍵接點

1. **Campaign → Round**:`newRoundState(campaign)` 在 [src/rounds/state.ts](../src/rounds/state.ts) 呼叫 `pickOperations`,輸出 `RoundOperationOption[]`。
2. **Round → Run**:`RoundSetupScene.commitOption` 在 [src/presentation/scenes/RoundSetupScene.ts](../src/presentation/scenes/RoundSetupScene.ts) 把 OperationInstance + squad 包成 RunState、呼叫 `saveRun`。同時 `resolveUnpickedOptions` 預骰未選 option 的命運存進 `RunState.unpickedOutcomes`。
3. **Run → Mission**:`BattleScene` 接 `{ runState }`,從 `runState.missionIds[runState.missionIndex]` 載入 mission。
4. **Mission → Run**:`ResultScene.onContinue` 呼叫 `advanceAfterMission(runState, missionResult)`,推進 missionIndex、bankedRewards;若還有下一關 → HubScene、否則 → RunResultScene。
5. **Run → Campaign**:`RunResultScene.applyCampaignOutcome` 建構 `RunOutcome` discriminated union,呼叫 `advanceCampaignAfterRun(campaign, resolution)`,寫回 `czl.campaign.v1`、清掉 `czl.run.v1`。

---

## 不要踩的雷

- **`bundles.gen.ts` 是 codegen 產物** — 改 config JSON 後跑 `npm run gen-bundles`(`predev` / `prebuild` / `pretest` 已自動掛 hook)。手改它會被覆蓋。
- **`unit.traits.includes('X')` 不要用** — 走 `unitHasTrait(u, 'X')`(見 [tag-system.md](tag-system.md));`includes` 抓不到 `'ARMOR:2'` 這種帶參數的 trait。
- **core/ 不可 import campaign/run/round** — 反過來可以。違反這規則會把 reducer 拖進 meta 邏輯,難以 unit test。
- **Phaser scene 之間別偷用 globals** — 用 `init(data)` 傳;`scene.start('Foo', data)`。
- **編輯器存的東西(`czl.editor.*`)優先於 bundled** — debug 怪資料時先看 localStorage,不是 JSON。
