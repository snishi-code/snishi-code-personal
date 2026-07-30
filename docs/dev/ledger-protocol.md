# simple-ledger — データ形式と import ポリシー

実装: `apps/simple-ledger/src/domain/schema.ts`（Zod）、
`apps/simple-ledger/src/data/exportImport.ts`、`apps/simple-ledger/src/data/repository.ts`。

## 保存方針

- **実行時の正本 = IndexedDB**（`DB_NAME = "simple-ledger-v2"`）。ストア:
  `kv`（meta / settings）、`accounts`、`journalEntries`、`cashflowSchedules`、
  `tags`、`monthlyCostItems`、`recurringRules`、`snapshots`。
- **公式交換形式 = JSON**（端末間共有・バックアップ）。JSON をDB代わりに常用しない。
- **計算で生まれる仕訳は保存しない**: 継続コスト資産の費用の行・ルールの未来投影は
  `reportEntriesForAsOf` が表示のたびに展開する導出専用で、IndexedDB / export / スナップショットの
  どこにも書かれない（`assertEntrySavable` が `metadata.virtual` 付き仕訳の保存を例外で拒否する）。

## JSON export パッケージ

`LedgerExportPackage`（`src/domain/types.ts` / `schema.ts`）:

```jsonc
{
  "appId": "snishi-code.simple-ledger-v2",
  "schemaVersion": 5,
  "ledgerId": "ledger",
  "exportedAt": "2026-07-29T00:00:00.000Z",
  "deviceId": "<uuid>",
  "revision": 12,          // foundation 封筒の revision（楽観的衝突検出）
  "accounts": [ /* Account[]（type + role 付き） */ ],
  "journalEntries": [ /* JournalEntry[]（保存される仕訳のみ） */ ],
  "cashflowSchedules": [ /* CashflowSchedule[]（予定キャッシュフロー） */ ],
  "tags": [ /* Tag[]（分析タグ） */ ],
  "monthlyCostItems": [ /* MonthlyCostItem[]（継続コスト資産） */ ],
  "recurringRules": [ /* RecurringRule[]（定期ルール） */ ],
  "settings": { "ledgerName": "家計簿", "currency": "JPY", "locale": "ja" }
}
```

- `Account.role`: `type` と整合する UI 用役割（`daily-asset` /
  `investment-asset` / `continuing-cost-asset`（内部集約＝継続コスト台帳）/ `payment-liability` /
  `other-liability` / `equity` / `income-category` / `expense-category` / `system-adjustment`）。
  詳細は [ledger-concept.md](ledger-concept.md#中核モデル)。import 検証で `role` と `type` の
  整合も確認する。
- `Account.movable?`（「自由に動かせる」）: `daily-asset` のみ・**保存されるのは `false` だけ**
  （ON = 既定は `undefined`。`true` や `daily-asset` 以外に付いた値は import 時に strip /
  剥がして自己修復する）。資金繰りの原資の判定にだけ使う。
- `revision`: 端末ローカルの編集追跡。保存のたびに +1。
- 金額（`JournalLine.amount`）は **正の整数・最小通貨単位**（JPY なら円）。

### schemaVersion の変遷（simple-ledger-v2。appId `snishi-code.simple-ledger-v2`）

> 旧 v1 アプリ（v1〜v16）の歴史は版 1 に畳んだ。**後方互換をコードで持たない**（作者決定）＝
> migration step を追加せず、旧版 JSON は unsupported-version で fail-closed に拒否し、
> 実データは単発の変換スクリプトで前進させる（下記）。

| 版 | 変更 |
|---|---|
| **v1** | v1 アプリの最終形（旧 v16 相当）を版 1 として開始（レガシー migration なし）。 |
| **v1→v2**（2026-07-28） | 使われていなかった 2 概念を型・schema・store・UI ごと撤去。IndexedDB は DB_VERSION 3 の upgrade で旧ストアを削除。 |
| **v2→v3**（2026-07-29・指示書#4） | 廃止概念の一掃（`fixed-asset` / `deferred-asset` role・按分 `allocations`・投資評価損益）・補正の通常化・並び順の正本化・ヘッダーの日付選択化・用語統一。旧 `allocations` ストアを削除（DB_VERSION 4）。 |
| **v3→v4**（2026-07-30・指示書#5） | **継続コスト資産の4項目モデル一本化**。`MonthlyCostItem` を 8 フィールド化（`startDate`/`endDate?`。`kind`/`costMonths`/`repeatEveryMonths`/`startMonth`/`endMonth`/`paymentSourceAccountId`/`recognitionCreditAccountId`/`status` 等を撤去）。**購入の仕訳を保存される仕訳にする**（`metadata.monthlyCostId`）。回収の振替（`metadata.monthlyCostRecovery`）を追加。`AssetDisposal`（処分）・一時停止・実績動的償却を全廃（`assetDisposals` ストア削除。DB_VERSION 5）。`RecurringRule` に `everyMonths`（必須）と `spreadExpenseAccountId?`（月割りするルール）を追加。科目名「開始残高」→「初期残高」。実データの変換 = `_workspace-management/scripts/convert-ledger-v3-to-v4.mjs`（単発・アプリ内 migration なし）。 |
| **v4→v5**（2026-07-30・実ユーズレビュー第2弾） | **取り置きの機能ごと全廃**（`reserves` ストア・`ReserveItem`・`metadata.reserveId`・role `reserve-asset`・予定 CF の `source:'reserve'` を撤去。DB_VERSION 6）。**`Account.movable?`（「自由に動かせる」・現預金のみ・`false` だけ保存）を追加**（資金繰りの原資 =「自由に動かせるお金」1 値）。**支出ルールは周期にかかわらず常に台帳経由**（月割りするルールの条件 `everyMonths >= 2` を撤廃・`>= 1`。簿記編集ルールにも継続コスト化を開放し、購入の仕訳の貸方・ルールの源泉/費用の行き先は内部集約・残高調整以外の全 role = `RECURRING_POSTABLE_ROLES`）。過去に起票済みの支出形ルール由来の仕訳も変換で台帳経由へ揃えた。実データの変換 = `_workspace-management/scripts/convert-ledger-v4-to-v5.mjs`（単発・アプリ内 migration なし）。 |

### `MonthlyCostItem`（継続コスト資産）

`id` / `name` / `amount`（購入額・正の整数）/ `startDate`('YYYY-MM-DD'・**購入の仕訳の日付と
完全一致**) / `endDate?`（任意。未設定 = 費用の割り振りをしない）/ `expenseAccountId`（費用の
行き先）/ `createdAt` / `updatedAt`。

- **購入の仕訳**（保存される仕訳・item と 1:1）: `借方 継続コスト台帳(continuing-cost-ledger) /
  貸方 支払い元`。印は `metadata.monthlyCostId` のみ。持ち込み登録（貸方 = 初期残高 equity）は
  `kind:'opening'`。
- **回収の振替**（アーカイブ時の売却・返金）: `借方 振替先 / 貸方 継続コスト台帳`・
  `metadata: { monthlyCostId, monthlyCostRecovery: true }`。普通のユーザー入力の振替として
  編集・削除可。
- 費用の行は保存されない（`continuousCostEntriesForItem` が展開する）。
- ルール生成 item の id は決定的（`ccr-{ruleId}-{YYYY-MM}`）。ルール起票の保存仕訳は
  `rec-{ruleId}-{month}`。

### `RecurringRule`（定期ルール）

`id` / `name` / `amount` / `dayOfMonth` / `everyMonths`（必須。1 = 毎月）/
`spreadExpenseAccountId?`（**あれば月割りするルール** = 起票が購入の仕訳 + item を対で作る）/
`debitAccountId`（月割りルールでは継続コスト台帳に固定）/ `creditAccountId` / `startMonth`
（位相の基点）/ `postedThroughMonth?`（起票カーソル）/ `paused?`。

### `Tag`（分析タグ）

`id` / `name` / `scope`（`'entry'` のみ＝仕訳全体。明細タグは廃止）/ `color?` / `archived`。

### `CashflowSchedule`

- 予定キャッシュフロー。`direction`('inflow'|'outflow'|'transfer') /
  `source`('manual'|'credit-card'|'installment') / `status`('planned'|'posted'|'cancelled')。
  新規生成は無い（レガシーの一覧・実績化・削除のみ）。

### `JournalEntry.metadata`（任意）

```jsonc
"metadata": {
  "inputMode": "income | expense | transfer | manual | reversal",
  "reversalOfEntryId": "<元仕訳 ID（reversal のとき）>",
  // 残高補正（現実アンカー。「締め」は作らない）。編集・削除は補正画面のみ（Journal は読み取り専用）。
  "adjustment": {
    "accountId": "<asset|liability>",
    "expectedBalance": 10000,
    "actualBalance": 8000,
    "delta": -2000,            // actual − expected
    "counterpartAccountId": "<残高調整費/収入>"
  },
  // 継続コスト資産に紐づく保存仕訳の印。recovery なし = 購入の仕訳 / あり = 回収の振替。
  "monthlyCostId": "<monthlyCostItems[].id>",
  "monthlyCostRecovery": true,
  // 定期ルールからの自動起票の由来（必ずペアで持つ）。
  "recurringRuleId": "<recurringRules[].id>",
  "recurringMonth": "2026-07"
}
```

`virtual` / `continuousCostId` / `ccKind` は**計算で生まれる仕訳専用の印**で、
`entryMetadataSchema` に存在しない（保存される仕訳に付けると保存境界が例外で拒否し、
import では strip される）。

### 構造・参照整合性（import 検証）

`journalEntrySchema` / `ledgerExportPackageSchema` は次も検証する（不一致は `validation-error`）:

- **仕訳は「1 借方・1 貸方・同額」の 2 行のみ**（複合仕訳 UI 未対応のため fail-closed）。
- すべての `lines[].accountId` が `accounts[].id` に存在する。`accounts[].id` は一意・
  `role` は `type` と整合・有効（非アーカイブ）な科目名は trim 後で重複不可。
- 内部集約ロールは唯一の集約口座のみ（`continuing-cost-asset` = `continuing-cost-ledger`）。
- **継続コスト資産の不変条件**:
  - 各 item に**購入の仕訳がちょうど 1 件**（`metadata.monthlyCostId === item.id`・recovery なし）。
    `monthlyCostId` を持つ仕訳の参照先 item が存在する。
  - 購入の仕訳の形: 借方 = 継続コスト台帳、貸方 = 内部集約・残高調整以外の全 role
    （`RECURRING_POSTABLE_ROLES`。equity=初期残高・収入カテゴリも可）、金額 == `item.amount`、
    **`date === item.startDate`（日レベル）**。
  - **台帳に触れる保存仕訳は必ず `monthlyCostId` を持つ**（購入の仕訳 / 回収の振替の 2 種類だけ）。
  - 回収の振替は貸方 = 台帳（回収額の上限は設けない＝割り振る総額が負になってよい）。
  - `endDate?` は `>= startDate`・配分月数 ≤ 1200 ヶ月。`expenseAccountId` は内部集約・残高調整
    以外（`isRecurringPostableRole`）。
  - **同一ルール由来（id `ccr-{ruleId}-…`）の item の月区間が重ならない**。
- **勘定科目の不変条件: アーカイブ済み（資産・負債）= 全仕訳から計算した最終残高が 0**。
- 定期ルール: `everyMonths >= 1`。月割りするルール（`spreadExpenseAccountId` あり）は
  **周期にかかわらず**借方 = 継続コスト台帳・源泉と費用の行き先は内部集約・残高調整以外の
  全 role（`RECURRING_POSTABLE_ROLES`）。定期ルール由来の仕訳は `recurringRuleId`/`recurringMonth`
  をペアで持ち、ルールが存在し、同ルール・同月の重複が無い。
- 残高補正: `delta === actualBalance − expectedBalance`・対象/相手科目の存在と形・kind=normal。
- 予定 CF / タグ: id 一意・参照整合（posted の予定 CF は存在する仕訳に紐づく等）。

### revision の原子性

本体の変更と `meta.revision` の +1 は **同一 IndexedDB トランザクション** で行う
（`repository.writeWithRevision`）。途中失敗で「本体だけ変わって revision が進まない」状態を
作らない。

## import ポリシー（fail-closed）

`importFromJsonText(text, { force })` の処理順（`src/data/exportImport.ts`）:

1. **JSON パース** … 失敗 → `parse-error`（既存データ不変）。
2. **封筒検証** … `appId` / `schemaVersion` を確認。
   - `appId` 不一致 → `not-our-file`。
   - `schemaVersion ≠ 現行` → `unsupported-version`（**migration チェーンは持たない**。実データは
     変換スクリプトで前進させてから import する）。
3. **完全検証（Zod）** … 上記の不変条件・借方=貸方の一致まで検査。失敗 → `validation-error`
  （既存データ不変）。
4. **revision 競合チェック** … ローカルの `revision ≠ ファイルの revision` かつ `force` 未指定
   → `revision-conflict`。**自動上書きしない・自動マージしない**。
5. **import 前スナップショット** … 現状を `snapshots` に保存。
6. **原子的置換** … 全ストアを 1 トランザクションで置換（成功確認前に既存を壊さない）。

復元（`restoreFromSnapshot`）も同様に、復元前スナップショットを取ってから原子的に置換する。
`schemaVersion` 不一致のスナップショットは復元不可で、起動時に自動削除される（版上げ直後に
「使えるように見えて復元できない」スナップショットを並べない）。

## migration ポリシー（後方互換をコードで持たない）

- `schemaVersion` を必ず持つ。現行は **`5`**（`SCHEMA_VERSION`・`src/data/constants.ts`）。
- **アプリ内に migration チェーンを持たない**（作者決定・単発変換方式）。版を上げたら:
  1. `SCHEMA_VERSION` を +1 する（旧版 JSON / スナップショットは fail-closed に拒否される）。
  2. 実データは書き出した JSON を**単発の変換スクリプト**（`_workspace-management/scripts/`）で
     新版へ変換し、新ビルドに import する。変換結果は必ず `ledgerExportPackageSchema` に通す。
  3. ストア構成が変わるときだけ `DB_VERSION` を上げる。upgrade は「現行 STORE に無いレガシー
     ストアを削除して不足を作る」冪等な形（`src/data/db.ts`）。
- 未対応版は **fail-closed**（取り込まない）。復旧面はルート直下の ErrorBoundary
  （JSON import / DB 全消去の 2 ボタン）が受ける。

## 外部送信ゼロとの関係

- export はブラウザ内で `Blob` + `blob:` URL を生成してダウンロードするだけ（外部送信なし）。
- import はユーザーが選んだローカルファイルを `File.text()` で読むだけ（外部送信なし）。
- 同期・送信機能はアプリに持たない（[ADR 0001](../adr/0001-local-first-ledger.md)）。
