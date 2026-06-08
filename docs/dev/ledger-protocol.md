# simple-ledger — データ形式と import ポリシー

実装: `simple-ledger-src/src/domain/schema.ts`（Zod）、`src/domain/migrations.ts`、
`src/data/exportImport.ts`、`src/data/repository.ts`。

## 保存方針

- **実行時の正本 = IndexedDB**（`DB_NAME = "simple-ledger"`）。ストア:
  `kv`（meta / settings）、`accounts`、`journalEntries`、`allocations`、
  `cashflowSchedules`、`reserves`、`tags`、`monthlyCostItems`、`fundingGoals`、`snapshots`。
- **公式交換形式 = JSON**（端末間共有・バックアップ）。JSON をDB代わりに常用しない。

## JSON export パッケージ

`LedgerExportPackage`（`src/domain/types.ts` / `schema.ts`）:

```jsonc
{
  "appId": "snishi-code.simple-ledger",
  "schemaVersion": 10,
  "ledgerId": "ledger",
  "exportedAt": "2026-06-06T00:00:00.000Z",
  "deviceId": "<uuid>",
  "baseRevision": 12,      // このエクスポートが基づくリビジョン
  "currentRevision": 12,   // エクスポート時点のリビジョン
  "accounts": [ /* Account[]（type + role 付き） */ ],
  "journalEntries": [ /* JournalEntry[]（tagIds / lines[].tagIds 付き） */ ],
  "allocations": [ /* AllocationItem[]（按分支出。月額化コストの基盤履歴） */ ],
  "cashflowSchedules": [ /* CashflowSchedule[]（予定キャッシュフロー） */ ],
  "reserves": [ /* ReserveItem[]（目的別資金） */ ],
  "tags": [ /* Tag[]（分析タグ） */ ],
  "monthlyCostItems": [ /* MonthlyCostItem[]（月額化コスト） */ ],
  "fundingGoals": [ /* FundingGoal[]（資金目標） */ ],
  "settings": { "ledgerName": "家計簿", "currency": "JPY", "locale": "ja" }
}
```

- `schemaVersion`: スキーマ版。現行は **`13`**（v1→v2 `allocations`、v2→v3
  `cashflowSchedules`/`reserves`、v3→v4 `tags`、v4→v5 残高補正 `metadata.adjustment`
  永続化＝恒等移行、v5→v6 勘定科目に `role`、v6→v7 月額化コスト `monthlyCostItems`、
  v7→v8 資金目標 `fundingGoals`、v8→v9 予定CF `direction` に `transfer`＝恒等移行、
  v9→v10 `role` に `fixed-asset` + `MonthlyCostItem` に `sourceEntryId`/`recognitionCreditAccountId`、
  v10→v11 管理区分/支払い手段、v11→v12 `assetDisposals`、
  v12→v13 継続コストの資産経由モデル: `role` に `continuing-cost-asset` + `MonthlyCostItem` に任意
  `paymentSourceAccountId` + `EntryMetadata` に `virtual`/`continuousCostId`/`ccKind`（拡張のみ＝恒等移行）。
  仮想仕訳は保存しない導出専用＝export には含めない）。
- `Settings.expectedAnnualReturnBps?`: 期待年利（bps 整数。例 5%=500、未指定 0）。資金目標の
  必要積立額の参考計算にのみ使う（投資助言ではない）。
- `Account.role`: `type` と整合する UI 用役割（`daily-asset` / `reserve-asset` /
  `deferred-asset` / `investment-asset` / `fixed-asset`（固定資産。現金でない asset・CF総資金外） /
  `payment-liability` / `other-liability` / `equity` /
  `income-category` / `expense-category` / `system-adjustment`）。詳細は
  [ledger-concept.md](ledger-concept.md#中核モデル)。import 検証で `role` と `type` の整合も確認する。
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

### `FundingGoal`（資金目標）

将来の大きな支出（車・老後・入院費など）への積立計画。**費用項目ではない**（支出カテゴリを持たない）。
`id` / `name` / `targetAmount` / `targetDate`('YYYY-MM-DD') / `currentAmount`(>=0) /
`sourceAccountId?`(role daily-asset|reserve-asset) / `status`('active'|'achieved'|'archived') /
`note?`。必要な毎月の積立額は `Settings.expectedAnnualReturnBps` を仮定して導出する
（`fundingGoal.requiredMonthlyContribution`。年利 0% は単純割り、それ以外は積立 FV 式。表示時に円へ丸める）。

### `AllocationItem`（按分支出）

`id` / `name` / `totalAmount` / `months` / `startMonth`('YYYY-MM') / `expenseAccountId` /
`paymentAccountId` / `deferredAccountId` / `sourceEntryId` / `recognitionEntryIds[]` /
`status`('active'|'completed'|'disposed'|'settled') / `createdAt` / `updatedAt`。
関連仕訳は `metadata.allocationId` / `allocationRole`('source'|'recognition') を持つ。詳細は
[ledger-concept.md](ledger-concept.md#按分支出長期の生活コスト)。

### `MonthlyCostItem`（継続コスト台帳）

> **v13 以降の正本は「資産経由モデル」**（`createContinuousCost`）。`MonthlyCostItem` を台帳ルールとし、
> 品目ごとの専用資産（role `continuing-cost-asset`）への `支払い元 → 対象資産`（資産化）/
> `対象資産 → 費用カテゴリ`（認識）を **`src/domain/continuousCost.ts` が仮想展開**する（実仕訳を保存しない）。
> `paymentSourceAccountId`=資産化の貸方。PL/BS/支出は `Ledger.derivedEntries`（実仕訳 + 仮想仕訳）で集計し、
> 対象資産残高に未認識分が残る。詳細は [ledger-concept.md](ledger-concept.md#継続コスト)。
> 以下の「支払い仕訳を残す」旧モデル（`createMonthlyCost`）と固定資産月額化（`saveEntryWithFixedAssetMonthly`）は
> 内部互換で残すが、新規入力は資産経由モデルに一本化した。

（旧モデル）サブスク・年払い・耐久財・定期イベントを統一して扱う。「実際の支払い事実」と「生活コストとしての
月割り認識」を分ける:
- **支払い仕訳**: 登録日(`date`)に `借方 費用カテゴリ / 貸方 支払い元`（daily-asset でも
  payment-liability でも作る。`metadata.monthlyCostId` 付き・通常編集/削除不可）。負債払いなら
  登録日に負債が立ち、返済 CF で取り崩す。
- **生活コスト認識**: 仕訳ではなく `MonthlyCostItem` の formula から導出する分析レイヤ
  （ダッシュボードは `monthlyCostId` 付き支払い仕訳を除外し、`monthlyCostForMonth` を足す＝二重計上しない）。
- **負債払い + 返済情報**があれば、返済予定 CF を **初回引落日(`repaymentStartDate`)** から回数分作る
  （購入日とは別）。
`id` / `name` / `kind`('subscription'|'prepaid-service'|'durable-asset'|'recurring-event') /
`amount` / `costMonths`(>=1) / `repeatEveryMonths?`(>=costMonths) / `startMonth`('YYYY-MM') /
`endMonth?` / `expenseAccountId`(role expense-category) / `paymentSourceAccountId?`(資産経由モデルの
資産化の貸方。daily-asset | payment-liability) / `paymentAccountId?`(旧モデル) / `repaymentAccountId?`(daily-asset) /
`recognitionCreditAccountId?`(資産経由は continuing-cost-asset、固定資産月額化は fixed-asset) /
`sourceAllocationId?` / `status`('active'|'paused'|'ended')。
- 月額は formula で導出: `monthlyAmounts(amount, costMonths)`（合計は必ず `amount` に一致）。
  `repeatEveryMonths` ありは周期ごとに先頭 `costMonths` か月だけ計上（隙間は 0）。
- 負債(payment-liability)払いは返済予定 `CashflowSchedule`(source='installment') を別に作る。
  **返済 CF と月額化コストは別物**（CF=いつ現金が動くか / 月額化=月あたりの生活コスト）。
- 既存按分(allocations)から移行した項目は `sourceAllocationId` を持つ。ダッシュボードの
  生活コストは「通常支出 − 既存按分の認識 − 調整用費用 + 月額化コスト(formula)」で**二重計上しない**。
  詳細は [ledger-concept.md](ledger-concept.md#月額化コスト)。

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
  // 残高補正（実残高との差分調整＝現実アンカー。「締め」は作らない）。
  // 後編集・削除は残高補正画面（updateAdjustment / deleteAdjustment）のみ。Journal の通常編集・削除は
  // fail-closed（error.entry.adjustment）。編集時の理論残高は補正自身を除いて再計算する。
  "adjustment": {
    "kind": "unknown-balance | investment-valuation",
    "accountId": "<asset|liability>",
    "expectedBalance": 10000,
    "actualBalance": 8000,
    "delta": -2000,            // actual − expected
    "counterpartAccountId": "<残高調整費/収入 or 投資評価損/益>"
  },
  // 月額化コスト（負債払い）の購入仕訳に付く。紐づく MonthlyCostItem の ID。
  "monthlyCostId": "<monthlyCostItems[].id>"
}
```

### 構造・参照整合性（import 検証）

`journalEntrySchema` / `ledgerExportPackageSchema` は次も検証する（不一致は `validation-error`）:

- **仕訳は「1 借方・1 貸方・同額」の 2 行のみ**（MVP は複合仕訳 UI 未対応のため fail-closed）。
- すべての `journalEntries[].lines[].accountId` が `accounts[].id` に存在する。
- `accounts[].id` は一意。`accounts[].role` は `type` と整合する（`roleAllowsType`）。
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
- **`monthlyCostItems[]`**: `id` 一意。`expenseAccountId` は role expense-category、
  `paymentAccountId?` は daily-asset|payment-liability、`repaymentAccountId?` は daily-asset、
  `repeatEveryMonths >= costMonths`、`sourceAllocationId?` は `allocations[].id` に存在する。
- **`fundingGoals[]`**: `id` 一意。`sourceAccountId?` は role daily-asset|reserve-asset。
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

- `schemaVersion` を必ず持つ。現行は `10`。
- migration 関数の置き場は `src/domain/migrations.ts` の `STEPS`（`{ from, to, migrate }`）。
  - **v1 → v2**: `allocations: []` を補う（v1 JSON は按分を持たない）。
  - **v2 → v3**: `cashflowSchedules: []` / `reserves: []` を補う。
  - **v3 → v4**: `tags: []` を補う。
  - **v4 → v5**: 残高補正（`metadata.adjustment`）の永続化に伴う版上げ。構造は変えない＝
    恒等移行（version だけ前進）。
  - **v5 → v6**: 勘定科目に `role` を補う。`type` と参照集合（按分中資産＝`allocations[].deferredAccountId`、
    目的別資金＝`reserves[].reserveAccountId`）・既定名から推定する（`accountRoles.inferRole`）。
  - **v6 → v7**: 月額化コスト `monthlyCostItems` を既存按分から移行生成する
    （`monthlyCostMigration.monthlyCostItemsFromAllocations`、`kind='durable-asset'`・
    `sourceAllocationId` 付き）。既存 `allocations` と生成済み仕訳は消さない（履歴保持）。
  - **v7 → v8**: 資金目標 `fundingGoals: []` を補う。`ReserveItem` は `targetDate` を持たないため
    自動移行はしない（既存データは保持）。
  - **v8 → v9**: 予定CF `direction` に `transfer`（口座間移動）を追加＝恒等移行（許容値拡張のみ）。
  - **v9 → v10**: `AccountRole` に `fixed-asset`、`MonthlyCostItem` に `sourceEntryId` /
    `recognitionCreditAccountId` を追加＝恒等移行（許容値・任意項目の拡張のみ）。
- 未対応版は **fail-closed**（取り込まない）。
- migration 失敗時は既存データを保持し、UI に失敗を通知する（握りつぶさない）。
- version を上げるときは `SCHEMA_VERSION` を +1 し、`STEPS` に旧→新の手順を追加する。
  新ストアを足すときだけ `DB_VERSION` を上げ、`onupgradeneeded` でストアを追加する（v2 で
  `allocations`、v3 で `cashflowSchedules` / `reserves`、v4 で `tags`、DB v5 で `monthlyCostItems`、
  DB v6 で `fundingGoals`）。schema v5（`metadata.adjustment`）と v6（`account.role`）は既存ストア内の
  項目追加のみのため `DB_VERSION` 据え置き、schema v7 で `DB_VERSION` を 5、v8 で 6 へ上げる。
- 既存 IndexedDB は起動時（`ensureInitialized`）に現行版へ前進させる。`meta.schemaVersion` を上げ、
  v6 では `role` の無い科目に `inferRole`、v7 では空なら `monthlyCostItems` を按分から補完する。
  **編集リビジョン（`revision`）は変えない**（恒等的な追従なので import の競合判定に影響させない）。

## 外部送信ゼロとの関係

- export はブラウザ内で `Blob` + `blob:` URL を生成してダウンロードするだけ（外部送信なし）。
- import はユーザーが選んだローカルファイルを `File.text()` で読むだけ（外部送信なし）。
- 同期・送信機能はアプリに持たない（[ADR 0001](../adr/0001-local-first-ledger.md)）。
