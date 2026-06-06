# simple-ledger — データ形式と import ポリシー

実装: `simple-ledger-src/src/domain/schema.ts`（Zod）、`src/domain/migrations.ts`、
`src/data/exportImport.ts`、`src/data/repository.ts`。

## 保存方針

- **実行時の正本 = IndexedDB**（`DB_NAME = "simple-ledger"`）。ストア:
  `kv`（meta / settings）、`accounts`、`journalEntries`、`snapshots`。
- **公式交換形式 = JSON**（端末間共有・バックアップ）。JSON をDB代わりに常用しない。

## JSON export パッケージ

`LedgerExportPackage`（`src/domain/types.ts` / `schema.ts`）:

```jsonc
{
  "appId": "snishi-code.simple-ledger",
  "schemaVersion": 4,
  "ledgerId": "ledger",
  "exportedAt": "2026-06-06T00:00:00.000Z",
  "deviceId": "<uuid>",
  "baseRevision": 12,      // このエクスポートが基づくリビジョン
  "currentRevision": 12,   // エクスポート時点のリビジョン
  "accounts": [ /* Account[] */ ],
  "journalEntries": [ /* JournalEntry[]（tagIds / lines[].tagIds 付き） */ ],
  "allocations": [ /* AllocationItem[]（按分支出） */ ],
  "cashflowSchedules": [ /* CashflowSchedule[]（予定キャッシュフロー） */ ],
  "reserves": [ /* ReserveItem[]（目的別資金） */ ],
  "tags": [ /* Tag[]（分析タグ） */ ],
  "settings": { "ledgerName": "家計簿", "currency": "JPY", "locale": "ja" }
}
```

- `schemaVersion`: スキーマ版。現行は **`4`**（v1→v2 `allocations`、v2→v3
  `cashflowSchedules`/`reserves`、v3→v4 `tags` を追加）。
- `revision`: 端末ローカルの編集追跡。保存（仕訳/科目/設定/按分/予定CF/目的別資金/タグ）のたびに +1。
- 金額（`JournalLine.amount`）は **正の整数・最小通貨単位**（JPY なら円）。

### `Tag`（分析タグ）

`id` / `name` / `scope`('entry'|'line'|'both') / `color?` / `archived`。勘定科目を増やさずに
旅行・カード名・銀行名などで抽出する分析軸。**PL/BS は変えない**。`JournalEntry.tagIds`（全体タグ、
scope entry|both）、`JournalLine.tagIds`（明細タグ、scope line|both）、`CashflowSchedule` の
`entryTagIds`/`accountLineTagIds`/`counterLineTagIds`（実績化時に仕訳へコピー）。

### `CashflowSchedule`（予定キャッシュフロー）/ `ReserveItem`（目的別資金）

- `CashflowSchedule`: `id` / `title` / `dueDate` / `amount` / `direction`('inflow'|'outflow') /
  `accountId`(asset) / `counterAccountId?` / `source`('manual'|'credit-card'|'installment'|'reserve') /
  `status`('planned'|'posted'|'cancelled') / `linkedEntryId?`。「いつ現金が動くか」を保持し、
  実績化で 1 件の 2 行仕訳（outflow: 借方 counter / 貸方 account）を作る。**予定は仕訳一覧へ
  大量生成しない**。
- `ReserveItem`: `id` / `name` / `reserveAccountId`(asset) / `targetAmount?` / `note?`。取り置きは
  通常の振替で行い、資金繰り画面で自由資金から除外して見る（総資産は不変）。

### `AllocationItem`（按分支出）

`id` / `name` / `totalAmount` / `months` / `startMonth`('YYYY-MM') / `expenseAccountId` /
`paymentAccountId` / `deferredAccountId` / `sourceEntryId` / `recognitionEntryIds[]` /
`status`('active'|'completed'|'disposed'|'settled') / `createdAt` / `updatedAt`。
関連仕訳は `metadata.allocationId` / `allocationRole`('source'|'recognition') を持つ。詳細は
[ledger-concept.md](ledger-concept.md#按分支出長期の生活コスト)。

### `JournalEntry.metadata`（任意）

仕訳の付帯情報。後方互換のため省略可能。

```jsonc
"metadata": {
  "inputMode": "income | expense | transfer | manual | reversal",
  "reversalOfEntryId": "<元仕訳 ID（reversal のとき）>",
  // 期間按分（将来拡張・保存と検証のみ。生成ロジックは未実装）
  "allocationPlan": {
    "kind": "period",
    "startDate": "2026-06-01",
    "endDate": "2026-12-31",
    "method": "even-monthly",
    "recognitionAccountId": "<acc>",
    "deferredAccountId": "<acc>",
    "generatedEntryIds": []
  },
  // 残高補正（実残高との差分調整。「締め」は作らない）
  "adjustment": {
    "kind": "unknown-balance | investment-valuation",
    "accountId": "<asset|liability>",
    "expectedBalance": 10000,
    "actualBalance": 8000,
    "delta": -2000,            // actual − expected
    "counterpartAccountId": "<残高調整費/収入 or 投資評価損/益>"
  }
}
```

### 構造・参照整合性（import 検証）

`journalEntrySchema` / `ledgerExportPackageSchema` は次も検証する（不一致は `validation-error`）:

- **仕訳は「1 借方・1 貸方・同額」の 2 行のみ**（MVP は複合仕訳 UI 未対応のため fail-closed）。
- すべての `journalEntries[].lines[].accountId` が `accounts[].id` に存在する。
- `accounts[].id` は一意。
- `metadata.allocationPlan` の `recognitionAccountId` / `deferredAccountId` が `accounts[].id` に存在し、
  `generatedEntryIds` の各 ID が `journalEntries[].id` に存在する。
- **`allocations[]`**: `id` は一意。`expenseAccountId` / `paymentAccountId` / `deferredAccountId` が
  `accounts[].id` に、`sourceEntryId` / `recognitionEntryIds[]` が `journalEntries[].id` に存在する。
  さらに科目 type（expense / payment=asset|liability / deferred=asset）、本数 = months、原始/認識
  仕訳のメタ・借方貸方・金額列・日付列・合計まで一致を検証。`allocationId` と `allocationRole` は
  必ず同時に存在し、`allocationId` 付き仕訳はいずれかの AllocationItem から参照される。
- **`cashflowSchedules[]`**: `id` 一意。`accountId` は asset、`counterAccountId?` は存在する科目、
  `status: 'posted'` は存在する `linkedEntryId` を持つ。
- **`reserves[]`**: `id` 一意。`reserveAccountId` は asset。
- **`tags[]`**: `id` 一意・active な同名重複なし。`tagIds` 参照は存在必須かつ scope 整合
  （全体タグ欄=entry|both、明細タグ欄=line|both）。仕訳・予定CF のタグ欄も同様に検証。
- **`metadata.adjustment`**: `accountId` / `counterpartAccountId` が `accounts[].id` に存在し、
  `delta === actualBalance − expectedBalance`。

### revision の原子性

本体（仕訳/科目/設定）の変更と `meta.revision` の +1 は **同一 IndexedDB トランザクション** で行う
（`repository.writeWithRevision`）。途中失敗で「本体だけ変わって revision が進まない」状態を作らない。
revision は import の競合判定に使うため、本体と必ず歩調を合わせる。

## import ポリシー（fail-closed）

`importFromJsonText(text, { force })` の処理順（`src/data/exportImport.ts`）:

1. **JSON パース** … 失敗 → `parse-error`（既存データ不変）。
2. **封筒検証** … `appId` / `schemaVersion` を確認。
   - `appId` 不一致 → `not-our-file`。
3. **migration** … `schemaVersion ≠ 現行` なら `migrateToCurrent` で前進。
   - 現行より新しい → `unsupported-version`（`too-new`）。
   - 手順が無い旧版 / 変換失敗 → `unsupported-version`（`unknown-version` / `migration-failed`）。
4. **完全検証（Zod）** … 借方=貸方の一致まで検査。失敗 → `validation-error`（既存データ不変）。
5. **revision 競合チェック** … ローカルの `revision ≠ ファイルの baseRevision` かつ `force` 未指定
   → `revision-conflict`。**自動上書きしない・自動マージしない**。UI が警告し、ユーザー確認
   （force）を得てから再実行する。
6. **import 前スナップショット** … 現状を `snapshots` に保存（理由「import前」）。
7. **原子的置換** … `meta` / `settings` / `accounts` / `journalEntries` を 1 トランザクションで
   置換。ここで初めて既存を更新する（= 成功確認前に既存を成功扱いで壊さない）。`snapshots` は残す。

復元（`restoreFromSnapshot`）も同様に、復元前スナップショットを取ってから原子的に置換する。

## migration ポリシー

- `schemaVersion` を必ず持つ。現行は `4`。
- migration 関数の置き場は `src/domain/migrations.ts` の `STEPS`（`{ from, to, migrate }`）。
  - **v1 → v2**: `allocations: []` を補う（v1 JSON は按分を持たない）。
  - **v2 → v3**: `cashflowSchedules: []` / `reserves: []` を補う。
  - **v3 → v4**: `tags: []` を補う。
- 未対応版は **fail-closed**（取り込まない）。
- migration 失敗時は既存データを保持し、UI に失敗を通知する（握りつぶさない）。
- version を上げるときは `SCHEMA_VERSION` を +1 し、`STEPS` に旧→新の手順を追加する。
  IndexedDB も `DB_VERSION` を上げ、`onupgradeneeded` でストアを追加する（v2 で `allocations`、
  v3 で `cashflowSchedules` / `reserves`、v4 で `tags` を追加）。

## 外部送信ゼロとの関係

- export はブラウザ内で `Blob` + `blob:` URL を生成してダウンロードするだけ（外部送信なし）。
- import はユーザーが選んだローカルファイルを `File.text()` で読むだけ（外部送信なし）。
- 同期・送信機能はアプリに持たない（[ADR 0001](../adr/0001-local-first-ledger.md)）。
