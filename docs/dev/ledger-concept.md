# simple-ledger — 会計コンセプト

個人カテゴリの家計簿アプリ `simple-ledger` の会計モデル。実装は
`simple-ledger-src/src/domain/`。

## なぜ Spreadsheet ではなく PWA か

旧版は GAS + Google Spreadsheet で、入力のたびに Google サーバーと通信していた。
これはサイト憲法（**外部送信ゼロ・例外なし**）と両立しない。本アプリは概念だけを
引き継ぎ、次の前提で作り直した。

- **外部送信ゼロ**: アプリ内に `fetch` 等の送信系を一切持たない。
- **ローカルファースト**: 実行時の正本は端末内 IndexedDB。
- **オフライン動作**: Service Worker で app shell をキャッシュし、ネット無しで動く。
- **公式交換形式は JSON**: 端末間共有・バックアップは JSON export/import で行い、
  同期はアプリ外手段（Obsidian Sync など）に委ねる。アプリは同期・送信を実装しない。

> 旧 GAS コードは参照しない・移植しない。命名（`INPUT` / `PL` / `BS` / `CF` /
> `INVENTORY`）も使わない。すべて会計の標準語彙へ翻訳した。

## 旧概念 → 会計モデルの対応

| 旧（GAS） | 本アプリ | 補足 |
|---|---|---|
| `INPUT`（1 行の収支） | `JournalEntry`（仕訳） | 借方/貸方の 2 行で表す |
| `source` / `dest`, `+/-` | `JournalLine.side`（`debit`/`credit`） | 独自符号は使わない |
| `PL` シート | `ProfitAndLoss`（導出） | 保存しない。毎回計算 |
| `BS` シート | `BalanceSheet`（導出） | 保存しない。毎回計算 |
| `CF` | （将来）`cashFlow` | MVP 対象外 |
| `INVENTORY` | （将来）`fixedAssets` / `assetRegister` | MVP 対象外 |

## 中核モデル

- **`Account`（勘定科目）**: `id` / `name` / `type` / `archived`。
  `type` は `asset` / `liability` / `equity` / `revenue` / `expense`。
- **`JournalEntry`（仕訳）**: `date` / `description` / `lines[]` / `kind` / `memo`。
  MVP では `lines` は「1 借方・1 貸方・同額」の 2 行のみ（型は複数行を許し将来拡張可能）。
  `kind` は `normal` / `opening`（初期残高）。
- **`JournalLine`**: `accountId` / `side`（`debit`/`credit`）/ `amount`（正の整数・最小通貨単位）。

### 複式の符号ルール（`domain/accounting.ts`）

- `asset` / `expense` … 借方が正（残高 = Σ借方 − Σ貸方）
- `liability` / `equity` / `revenue` … 貸方が正（残高 = Σ貸方 − Σ借方）

例（食費 1000 円を現金で支払う）:

```
借方 食費(expense) 1000 / 貸方 現金(asset) 1000
```

→ 食費 +1000（費用増）、現金 −1000（資産減）。

## PL / BS の導出

PL も BS も **保存しない**。`Account` と `JournalEntry` から毎回計算する（単一の正本）。

- **PL**: `revenue` と `expense` の残高から。`netIncome = totalRevenue − totalExpense`。
  期間 `[from, to]`（両端含む）で絞り込める。
- **BS**: `asset` / `liability` / `equity` の残高から。MVP は未締めのため、当期純損益
  （`revenue − expense`）を `retainedEarnings` として純資産に算入し、貸借を一致させる。
  - `純資産(netAssets) = 資産 − 負債 = equity 科目合計 + 当期純損益`
  - `balanced` フラグで貸借一致を検証（仕訳が常に balanced なら true）。

## 初期残高

開始時点の資産・負債は **仕訳として** 登録する（`kind = 'opening'`）。UI では「初期残高」と
見せるが、集計上は通常の仕訳と同じに扱う。これにより BS の導出ロジックを 1 本に保てる。

例: 現金 100,000 円を元入金として持っている →
`借方 現金 100000 / 貸方 元入金(equity) 100000`（kind=opening）。

## 日常入力（収入/支出/振替）→ 仕訳への変換

ユーザーには借方/貸方を意識させず、意味のあるフィールドで 2 科目を選ばせる。内部では
必ず複式へ変換する（対応は `src/ui/entryModes.ts`、入力方法は `JournalEntry.metadata.inputMode`）。

| 入力 | フィールド（debit / credit） | 候補タイプ |
|---|---|---|
| 収入 | 入金先(debit) / カテゴリ(credit) | asset / revenue |
| 支出 | カテゴリ(debit) / 支払元(credit) | expense / asset・liability |
| 振替 | 振替先(debit) / 振替元(credit) | asset・liability・equity（両側） |
| 詳細(manual) | 借方 / 貸方 | すべて |

例（支出）: カテゴリ=食費・支払元=現金・1000 →
`借方 食費(expense) 1000 / 貸方 現金(asset) 1000`（metadata.inputMode='expense'）。

## 取消/返金（逆仕訳）

実取引のキャンセル・返金は、元仕訳を**削除せず**、借方/貸方を入れ替えた逆仕訳を作る
（`reversalInput`）。金額は既定で元と同額、編集可能（部分返金）。`metadata` に
`inputMode='reversal'` と `reversalOfEntryId`（元仕訳 ID）を残す。入力ミス直後の訂正は
編集/削除でよいが、実取引の取消は逆仕訳を推奨する。

例: 元 `借方 食費 / 貸方 カード 1000` → 取消 `借方 カード / 貸方 食費 1000`。

## 期間按分（将来拡張・データ構造のみ）

`JournalEntry.metadata.allocationPlan`（`kind:'period'` / `startDate` / `endDate` /
`method:'even-monthly'` / `recognitionAccountId` / `deferredAccountId` / `generatedEntryIds`）を
用意してある。**MVP では保存・export/import・スキーマ検証が通るだけ**で、按分仕訳の自動
生成ロジックと UI は未実装。

## 勘定科目の変更ルール（`Account`）

- 名前変更: 同一 `id` の表示名を変える。過去仕訳も新名称で表示。
- 新規追加: 以後の科目として追加。
- 物理削除: **未使用のみ可**（仕訳から参照中は不可・アーカイブを使う）。
- 区分(type)変更: **未使用のみ可**（使用中は禁止）。UI で無効化し、`upsertAccount` でも fail-closed。

## 関連

- データ形式・import ポリシー: [ledger-protocol.md](ledger-protocol.md)
- 画面/UX: [ledger-ui-ux.md](ledger-ui-ux.md)
- 設計判断（ローカルファースト）: [../adr/0001-local-first-ledger.md](../adr/0001-local-first-ledger.md)
