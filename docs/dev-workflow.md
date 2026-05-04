## 開發流程速查

> 寫給「要動程式碼前先確認流程」的場合。指令、commit 慣例、踩雷點集中於此。

---

## npm scripts 對照

| 指令 | 做什麼 | 何時用 |
|---|---|---|
| `npm run dev` | Vite dev server(熱重載) | 一般開發 / UI 手測 |
| `npm run build` | `tsc --noEmit` 後 `vite build` | 確認 production build 過得了 |
| `npm run test` | `vitest run`(單次跑完) | commit 前必跑 |
| `npm run test:watch` | vitest watch 模式 | 寫測試 / TDD 時 |
| `npm run sim` | headless 批量對戰 KPI | AI / 平衡迴歸 |
| `npm run probe` | A↔B 連通性測試 | 改地圖 / pathfinder 後 |
| `npm run gen-bundles` | scan `src/config/` → 產 `bundles.gen.ts` | 加新 mission / unit / op JSON 後(其他 npm script 已 pre-hook 自動跑) |

**Pre-hook 自動掛點**:`predev` / `prebuild` / `pretest` / `presim` / `preprobe` 都會先跑 `gen-bundles`,所以新增 JSON 檔後不必手動先跑(但手動修改 `src/config/loader.ts` 等程式檔則直接 dev 即可)。

---

## 提交前的最小驗證

```bash
npx tsc --noEmit          # 型別
npm run test -- --run     # 單元 / 整合 (vitest run 也行)
```

兩者皆綠才 commit。動到 AI / 平衡:加跑 `npm run sim` 看 KPI 沒退化。

**只跑單一 test 檔**:

```bash
npm run test -- --run src/operations/picker.test.ts
```

---

## Commit 慣例

- **訊息語言**:中文(看近期 git log 即可)
- **格式**:`<主題>:<簡述>`(冒號用全形或半形視主題慣性)
- **多 stage 工作**:`<主題> Stage N:<該階段做了什麼>` — 見 commit `dec6508` / `402e6ab` / `8c5790a` / `8683485` 的 Operation 系統四階段
- **附加 Co-Authored-By**:Claude 出手的 commit 末段加 `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`
- **staging**:用具名檔案 `git add <path>`,**不要** `git add -A` / `git add .`(避免帶進編輯器自動存檔的 JSON 草稿、暫存日誌等)

**範例 commit message(用 heredoc 保留換行)**:

```bash
git commit -m "$(cat <<'EOF'
Operation 系統 Stage N:<簡述>

<2-3 句說明:做了什麼、為什麼這樣切>

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Codegen 注意事項

- **`src/config/bundles.gen.ts` 是產物** — 不要手改。改 `src/config/{missions,operations,units,weapons,factions,maps}/*.json` 後跑 `npm run gen-bundles`(或任何掛了 pre-hook 的 npm script)
- **`src/config/loader.ts`** 才是手寫的查詢介面;新 entity 種類(例如將來加 skills)要在 loader 加一份 list/get API
- 編輯器(瀏覽器內 `editor.html`)寫入 `czl.editor.*.v1` localStorage 草稿;loader 在執行期會把 localStorage 蓋在 bundled 之上。**debug 怪資料先看 localStorage**

---

## localStorage debug 速查

打開瀏覽器 DevTools → Application → Local Storage,過濾 `czl.`:

| 找什麼 | 看哪個 key |
|---|---|
| 進度卡住、resume 怪 | `czl.run.v1`(in-flight run)/ `czl.campaign.v1`(meta) — 整個欄位都可在 console 直接 `JSON.parse(localStorage['czl.run.v1'])` |
| Replay 不見了 | `czl.replay.index` 列出 5 槽 metadata,個別內容在 `czl.replay.<id>` |
| 編輯器資料消失 / 髒資料 | `czl.editor.{weapons,templates,factions,maps,missions,operations}.v1` |

**全清重來**:`localStorage.clear()`(這會連 replay 一起清;只清進度的話手動刪 `czl.campaign.v1` 和 `czl.run.v1`)

---

## SSR-safe persist 模式

所有 `*/persist.ts` 檔都遵守:

```ts
const hasStorage = typeof window !== 'undefined' && !!window.localStorage;
export function save(state: Foo): void {
  if (!hasStorage) return;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* noop */ }
}
```

**為什麼**:vitest 用 jsdom 跑時 localStorage 行為不可靠,test-only 路徑會炸。寫新的 persist 檔請照抄這個 shape。

---

## Sim CLI 用法

```bash
npm run sim -- --help                 # 看選項
npm run sim -- --mission <id> -n 100  # 跑某任務 100 場、印 KPI
npm run sim -- --all -n 30            # 全任務各跑 30 場
```

KPI 包含:A 勝率、平均 cycle、平均存活、平均命中率。用於確認 AI / trait / 平衡改動沒打破既有任務。

---

## 加新東西的順序提醒

| 加 | 順序 |
|---|---|
| 新 trait | 看 [tag-system.md](tag-system.md) §「加新 trait 流程」(registry → effect 掛點 → test) |
| 新 mission | `src/config/missions/*.json` → `gen-bundles` → 編輯器或 sim 驗證 |
| 新 operation | `src/config/operations/*.json` → `gen-bundles` → `pickOperations` 自動帶入(注意 difficulty 1-5、stages 結構) |
| 新 scenario | `src/core/scenarios/<name>.ts` 加 evaluator → `scenarioRegistry.ts` 註冊 → mission JSON 引用 |
| 新 scene | `src/presentation/scenes/<Name>Scene.ts` → `src/main.ts` 註冊到 Phaser config 的 `scene` 陣列 |

---

## 不要做

- 跳過 hook(`--no-verify`)— 沒必要;pre-commit 沒設 hook,test 出錯就老實修
- `git push --force` 到 main — 沒人共事但養成習慣
- 改 `bundles.gen.ts` — 上面提過,再寫一次因為很容易忘
- 在 `core/` import `campaign/` `run/` `round/` — 反向才合法,違反會把 reducer 拖進 meta 邏輯
