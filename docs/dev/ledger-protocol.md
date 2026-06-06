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
  "schemaVersion": 1,
  "ledgerId": "ledger",
  "exportedAt": "2026-06-06T00:00:00.000Z",
  "deviceId": "<uuid>",
  "baseRevision": 12,      // このエクスポートが基づくリビジョン
  "currentRevision": 12,   // エクスポート時点のリビジョン
  "accounts": [ /* Account[] */ ],
  "journalEntries": [ /* JournalEntry[] */ ],
  "settings": { "ledgerName": "家計簿", "currency": "JPY", "locale": "ja" }
}
```

- `schemaVersion`: スキーマ版。MVP 初期は `1`。
- `revision`: 端末ローカルの編集追跡。保存（仕訳/科目/設定の変更）のたびに +1。
- 金額（`JournalLine.amount`）は **正の整数・最小通貨単位**（JPY なら円）。

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

- `schemaVersion` を必ず持つ。MVP 初期は `1`。
- migration 関数の置き場は `src/domain/migrations.ts` の `STEPS`（`{ from, to, migrate }`）。
- 未対応版は **fail-closed**（取り込まない）。
- migration 失敗時は既存データを保持し、UI に失敗を通知する（握りつぶさない）。
- version を上げるときは `SCHEMA_VERSION` を +1 し、`STEPS` に旧→新の手順を追加する。

## 外部送信ゼロとの関係

- export はブラウザ内で `Blob` + `blob:` URL を生成してダウンロードするだけ（外部送信なし）。
- import はユーザーが選んだローカルファイルを `File.text()` で読むだけ（外部送信なし）。
- 同期・送信機能はアプリに持たない（[ADR 0001](../adr/0001-local-first-ledger.md)）。
