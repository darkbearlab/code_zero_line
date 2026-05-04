# 開發進度與待辦

> 取代舊的 `docs/archive/implementation-roadmap.md` 5-phase 計畫。
> **最後更新:2026-05-04**(Operation 系統四階段 push 完之後)。
> 已出貨 / WIP / 不在 v1 範圍 三類分明,別跟設計願景混淆 — 願景在 [roguelite-design-summary.md](roguelite-design-summary.md)。

---

## 已出貨(可以正常玩、有測試覆蓋)

### 戰鬥引擎與 AI(原 PvP 遺產)
- 命令 reducer:MOVE / SHOOT / RALLY / VAULT / CLIMB / CRAWL / COMMAND_MOVE / COMMAND_RALLY / activations
- 自由 2D 空間、多邊形地形、圓形單位底板、確定性 sfc32 RNG
- 掩體 / 趴下 / 高低牆 / 困難地形 / 軟掩體 / 反應射擊窗口
- AI:`greedy` 1-ply、`lookahead` depth-2 beam-6,EV-gated reactions、formation-aware
- 已實裝 traits:OFFICER、STALWART、FRAGILE、ARMOR(N)、CUMBERSOME、TOUGH、STEALTH、CANNON_FODDER、FANATIC、IMPULSIVE_AGGRESSIVE、NO_PRONE、NO_CLIMB、NO_VAULT
- Scenarios:elimination、engage-reach、defend(holdout)、extract、assassinate(decapitation)、control-points(conquest)、breakthrough

### Roguelite campaign 層
- **Pool 補員**:`POOL_TARGET=30`,role floor 3 officer / 8 specialist / 19 regular,新戰役 + 每場結束自動補
- **三貨幣**:作戰 / 區域 / 榮譽,`advanceCampaignAfterRun` 統一發放
- **未選 option auto-resolve**:`resolveUnpickedOptions` 在 commitOption 當下預骰,結果存進 `RunState.unpickedOutcomes`
- **fuzzy 難度顯示**:`classifyFuzzy(squadQuality, missionDifficulty) → 'low'|'medium'|'high'`(見 [src/rounds/fuzzy.ts](../src/rounds/fuzzy.ts))
- **老兵 sortie 計數**:`RosterEntry.sorties` 累加,`veteranAdjustedQuality` 套用素質提升,RoundSetup 卡片顯示 ★ badge
- **持久升級樹**:`UpgradeScene` 花榮譽強化(已能花)
- **MetaScene 指揮部**:池子 / 貨幣 / 老兵瀏覽

### Multi-stage operation 系統(2026-05-04 全 4 階段完成)
- **Stage 1**(`dec6508`):MissionDef 加 `difficulty: 1..5`、新 OperationDef / OperationInstance schema、5 個範例 op、registry + 10 tests
- **Stage 2**(`402e6ab`):`pickOperations` 依 round difficulty cap 抽 + 鏈條實例化(elim filter / mainConstraints),`RoundState` 改持有 OperationInstance
- **Stage 3**(`8c5790a`):RunState 加 `operation` / `bankedRewards` / `retreated`、`retreatOperation` helper、新 `czl.run.v1` 持久化、CampaignState 加 `RunOutcome` discriminated union(SINGLE_MISSION / OPERATION_COMPLETE / OPERATION_FAILED / RETREATED),TitleScene 加 Resume Operation 按鈕
- **Stage 4**(`8683485`):RoundSetup 卡片顯示完整 op(主任務 + 鏈條 chips + 3 檔難度 + 預期總獎 + 隊員)、RunResult 標題依 outcome 分歧 + banked 顯示

### Tooling
- 編輯器:weapons / units / factions / maps / missions / operations 6 分頁(瀏覽器)
- `npm run gen-bundles`:scan config/ 產 `bundles.gen.ts`(每個 npm script 都有 pre-hook 自動跑)
- `npm run sim`:headless 批量對戰(AI 迴歸)
- `npm run probe`:A↔B 連通性測試
- Replay 系統:`czl.replay.*` 5-槽 ring buffer + ReplayScene
- 473 tests(48 test files)全綠

---

## WIP / 已知短板

### 任務內容
- **任務 cycle limit 大多 = 999**(等於沒時限);defend / extract / assassinate 需要正式 cycle 上限做平衡
- **decapitation VIP 配置太前**:sim 1.4 round 就死,需要往後排 + 加掩護
- **last-stand 攻方勝率 87-90% 過高**:重抓敵人 spawn + BLOCKER 切通道

### Round / Run 層
- **`RoundResolveScene` 已存在但 UI 簡化**:目前只跳轉、未把未選 option 結算可視化(誰活誰死、區域情報多少)
- **「放棄任務」按鈕**(設計 §4.1「沒接(放棄)」全員死)目前無 UI 入口;所有未選都走 fuzzy auto-resolve
- **MetaScene 池子瀏覽 UI** 雛形已有,但 30 人滿員時 layout 待優化

### AI
- **lookahead 對 IMPULSIVE 的評估**雖加了 hook,但常數 1.0 是估值;待 sim 跑數據再調
- **AI 不識 BLOCKER / HIGH_GROUND**:grid pathfinder 把 HIGH_GROUND 當地面障礙,lookahead 不模擬高地行走(playable 但非最優)

---

## 還沒開始

### 設計上明確要做、但本 phase 沒做
- **教學 run**(設計 §3.5「偵查部隊突圍」)— 沒 TutorialScene、沒首次遊玩判斷
- **Skill 系統**(設計 §6.3 / 老 roadmap Phase 4)— 沒 `src/skills/` 目錄;run 結算後給隨機老兵抽 skill 完全沒實作
- **Finale**(設計 §3.2-3.3)— 沒 `finale.ts`、沒 FinaleScene、沒解鎖檢查
- **計分表**(設計 §3.4)— campaign 結束的截圖頁
- **多人解鎖**(設計 §8)— TitleScene 只有「Multiplayer (locked)」placeholder
- **OperationInterludeDef 消費端**(犧牲打分歧任務) — schema 已留,picker / Hub 未讀

### 5 個 stub traits
AGITATOR / WARLORD / MARTYRDOM 完全 stub;FANATIC / IMPULSIVE_AGGRESSIVE 已實裝(其他 IMPULSIVE 變體還沒)。faction rules 落地後再做。

### 內部清理小尾巴
- `Unit.activatedThisRound` / `cannotReactThisRound` 還沒改名 round → cycle(用語已改但 flag 沒)
- HUD C 式 EV 顯示 — 等 level 3+ 升級玩起來再決定要不要切

---

## 不在 v1 範圍

來自 archive/implementation-roadmap.md「Out of scope for v1」段:

- 在地化(英文 / 日文)— 中文 only ship
- 音效設計(stub SFX hook 之外)
- 動畫 polish(Stage 5 polish day 之外)
- 跨平台打包(Tauri / Steam)
- 多存檔槽
- 雲端同步
- Telemetry / analytics

任何想新增進這個列表的 scope creep,先 push back 給 user。

---

## 近期 commit 軌跡(往回看 15 筆)

```
8683485  Operation 系統 Stage 4:UI — 卡片鏈條預覽 + RunResult 文案分歧
8c5790a  Operation 系統 Stage 3:RunState 串接 + 撤退 + 持久化
402e6ab  Operation 系統 Stage 2:pickOperations + RoundState 接 OperationInstance
dec6508  Operation 系統 Stage 1:MissionDef 加 difficulty + Operation schema
bbe40d7  新增 NO_PRONE / NO_CLIMB / NO_VAULT 機動限制特質
d281d37  AI 評估識別 IMPULSIVE_AGGRESSIVE 觸發價值(Stage 4/4)
d469c55  IMPULSIVE_TRIGGERED 事件加入戰場字幕(Stage 3/4)
db21f64  IMPULSIVE × CANNON_FODDER 交互審查(Stage 2/4)
ff3c0db  IMPULSIVE 強制移動可被反應射擊(Stage 1/4)
9ca1ba2  實裝 IMPULSIVE_AGGRESSIVE:兩個強制觸發點 + 攻擊性行動選擇器
b05265e  新增 BEAST 分類標籤;修 FRAGILE 累積傷害 bug
14c2e5d  實裝 FANATIC:受阻反應命中不中斷行動
1a35fcb  LOS 預覽改用可見多邊形,斜邊不再有方格感
1a59894  修 control-points 在戰役中分數不更新的 bug
7b44e3b  新增 conquest 範例任務(control-points scenario)
```

軌跡:Operation 系統 → IMPULSIVE 完整實裝 → FANATIC + 機動限制 trait → bug 修。重點還是 traits 與 campaign loop 的整合。

---

## 推薦下一個方向(供討論用)

(以下不是承諾,user 可指定其他優先序。)

1. **任務內容平衡** — cycle limit / VIP 配置 / spawn 重抓。風險低、影響直接。
2. **教學 run** — 設計上很重要(三件事一起解:教學 + 敘事開場 + 解釋指揮部沒情報);實作不大。
3. **Skill 系統** — 設計 §6.3 已決定;這是「玩 20 個 run 後」的 retention 關鍵。
4. **RoundResolveScene 補完 UI** — 把未選 option 結算可視化,讓「該被犧牲的隊員」感受出來(Frostpunk 精神)。
5. **OperationInterludeDef 消費端** — Operation 系統已留 schema slot,接上犧牲打分歧任務 picker + Hub 第 3 個按鈕。
