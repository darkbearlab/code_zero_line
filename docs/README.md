# 開發文件索引

> 寫給接手這份程式碼的人(包含未來的自己 + IDE Claude)。
> 文件分三類:**規格** / **參考** / **歷史**。先看規格,再翻參考,歷史只在挖背景時讀。

---

## 規格 — 系統意圖(改動前先看)

| 文件 | 內容 | 何時看 |
|---|---|---|
| [rulebook.md](rulebook.md) | 桌遊原始規則 v1.5 | 任何規則疑問,以此為準 |
| [roguelite-design-summary.md](roguelite-design-summary.md) | Roguelite 設計概要(三層循環、貨幣、Hub framing) | 改動 campaign / run / hub 流程前 |
| [tag-system.md](tag-system.md) | Trait registry + 查詢 API + 加新 tag 流程 | 加新特質 / 改特質效果前 |

## 參考 — 程式碼現狀(找東西時看)

| 文件 | 內容 | 何時看 |
|---|---|---|
| [architecture.md](architecture.md) | 目錄樹、Phaser scene 圖、儲存 key 一覽、模組責任分工 | 不知道某功能在哪個檔案時 |
| [status.md](status.md) | 已出貨 / WIP / 待辦清單 + 近期 commit 軌跡 | 規劃下一階段、避免重作 |
| [dev-workflow.md](dev-workflow.md) | npm scripts、測試 / 編譯 / sim 指令、commit 慣例、codegen 注意事項 | 改 config 或要 commit 時 |

## 歷史 — 已被現實取代,僅留 archive

`docs/archive/` 收 4 份過時文件:roguelite 原始討論、open-questions 決策追蹤、5-phase 實作 roadmap、舊 Claude 對話 brief。設計脈絡已濃縮進上面 `roguelite-design-summary.md`,進度紀錄已濃縮進 `status.md`。**不要再依此規劃工作**。

---

## 寫文件的原則

1. **規格** 描述「應該如何」,不寫實作細節 — 實作細節改了不必動文件。
2. **參考** 描述「目前如何」,寫具體檔案路徑與 commit hash — 過時就改它。
3. 別在 markdown 裡複製 type 定義 — type 在原始碼會自動更新,文件抄一份只是製造維護負擔。需要時直接連到 source line。
4. 加新文件前先想:能不能塞進現有文件?塞不下再加。

---

## 給 IDE Claude

- 接手新 session 時先看 [status.md](status.md) 確認進度,再依任務性質讀對應規格。
- 大改動前先看 [architecture.md](architecture.md) 確認模組邊界。
- 規則 / 設計疑問先翻 [rulebook.md](rulebook.md) 與 [roguelite-design-summary.md](roguelite-design-summary.md);仍不確定再問使用者。
