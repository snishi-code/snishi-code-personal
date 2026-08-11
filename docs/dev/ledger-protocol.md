# simple-ledger — データ形式と import ポリシー

実装: `apps/simple-ledger/src/domain/schema.ts`（Zod）、
`apps/simple-ledger/src/data/exportImport.ts`、`apps/simple-ledger/src/data/repository.ts`。

## 保存方針

- **実行時の正本 = IndexedDB**（`DB_NAME = "simple-ledger-v2"`）。ストア:
  `kv`（meta / settings）、`accounts`、`journalEntries`、
  `tags`、`monthlyCostItems`、`recurringRules`、`snapshots`
  （v7 で `cashflowSchedules` を全廃。「予定」= 未来日付の通常仕訳）。
- **公式交換形式 = JSON**（端末間共有・バックアップ）。JSON をDB代わりに常用しない。
- **計算で生まれる仕訳は保存しない**: 継続コスト資産の費用の行・ルールの未来投影は
  `reportEntriesForAsOf` が表示のたびに展開する導出専用で、IndexedDB / export / スナップショットの
  どこにも書かれない（`assertEntrySavable` が `metadata.virtual` 付き仕訳の保存を例外で拒否する）。

## JSON export パッケージ

`LedgerExportPackage`（`src/domain/types.ts` / `schema.ts`）:

```jsonc
{
  "appId": "snishi-code.simple-ledger-v2",
  "schemaVersion": 10,
  "ledgerId": "ledger",
  "exportedAt": "2026-07-29T00:00:00.000Z",
  "deviceId": "<uuid>",
  "revision": 12, // foundation 封筒の revision（楽観的衝突検出）
  "accounts": [
    /* Account[]（type + role 付き） */
  ],
  "journalEntries": [
    /* JournalEntry[]（保存される仕訳のみ。未来日付の仕訳 = 「予定」もここに入る） */
  ],
  "tags": [
    /* Tag[]（分析タグ） */
  ],
  "monthlyCostItems": [
    /* MonthlyCostItem[]（継続コスト資産） */
  ],
  "recurringRules": [
    /* RecurringRule[]（定期ルール） */
  ],
  "settings": { "ledgerName": "家計簿", "currency": "JPY", "locale": "ja" },
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
- `Account.startDate?` / `endDate?`: 勘定科目が時間軸上に存在する両端（`YYYY-MM-DD`・両端を含む）。
  `startDate` 未設定時は `createdAt` の日付部分を表示・保存時の既定開始点とみなす。
  アーカイブ操作は今日を `endDate` に記録し、アーカイブ解除は `endDate` を消す。
  schema / DB の版は変えず、端点のない JSON も受理する。
- `revision`: 端末ローカルの編集追跡。保存のたびに +1。
- 金額（`JournalLine.amount`）は **正の整数・最小通貨単位**（JPY なら円）。

### schemaVersion の変遷（simple-ledger-v2。appId `snishi-code.simple-ledger-v2`）

> 旧 v1 アプリ（v1〜v16）の歴史は版 1 に畳んだ。**後方互換をコードで持たない**（作者決定）＝
> migration step を追加せず、旧版 JSON は unsupported-version で fail-closed に拒否し、
> 実データは単発の変換スクリプトで前進させる（下記）。

| 版                                             | 変更                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v1**                                         | v1 アプリの最終形（旧 v16 相当）を版 1 として開始（レガシー migration なし）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **v1→v2**（2026-07-28）                        | 使われていなかった 2 概念を型・schema・store・UI ごと撤去。IndexedDB は DB_VERSION 3 の upgrade で旧ストアを削除。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **v2→v3**（2026-07-29・指示書#4）              | 廃止概念の一掃（`fixed-asset` / `deferred-asset` role・按分 `allocations`・投資評価損益）・補正の通常化・並び順の正本化・ヘッダーの日付選択化・用語統一。旧 `allocations` ストアを削除（DB_VERSION 4）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **v3→v4**（2026-07-30・指示書#5）              | **継続コスト資産の4項目モデル一本化**。`MonthlyCostItem` を 8 フィールド化（`startDate`/`endDate?`。`kind`/`costMonths`/`repeatEveryMonths`/`startMonth`/`endMonth`/`paymentSourceAccountId`/`recognitionCreditAccountId`/`status` 等を撤去）。**購入の仕訳を保存される仕訳にする**（`metadata.monthlyCostId`）。回収の振替（`metadata.monthlyCostRecovery`）を追加。`AssetDisposal`（処分）・一時停止・実績動的償却を全廃（`assetDisposals` ストア削除。DB_VERSION 5）。`RecurringRule` に `everyMonths`（必須）と `spreadExpenseAccountId?`（月割りするルール）を追加。科目名「開始残高」→「初期残高」。実データの変換 = `_workspace-management/scripts/convert-ledger-v3-to-v4.mjs`（単発・アプリ内 migration なし）。                    |
| **v4→v5**（2026-07-30・実ユーズレビュー第2弾） | **取り置きの機能ごと全廃**（`reserves` ストア・`ReserveItem`・`metadata.reserveId`・role `reserve-asset`・予定 CF の `source:'reserve'` を撤去。DB_VERSION 6）。**`Account.movable?`（「自由に動かせる」・現預金のみ・`false` だけ保存）を追加**（資金繰りの原資 =「自由に動かせるお金」1 値）。**支出ルールは周期にかかわらず常に台帳経由**（月割りするルールの条件 `everyMonths >= 2` を撤廃・`>= 1`。簿記編集ルールにも継続コスト化を開放し、購入の仕訳の貸方・ルールの源泉/費用の行き先は内部集約・残高調整以外の全 role = `RECURRING_POSTABLE_ROLES`）。過去に起票済みの支出形ルール由来の仕訳も変換で台帳経由へ揃えた。実データの変換 = `_workspace-management/scripts/convert-ledger-v4-to-v5.mjs`（単発・アプリ内 migration なし）。 |
| **v5→v6**（2026-07-31・定期ルール線分化）      | `RecurringRule.startDate`（存在開始日・必須）と `endDate?`（排他的終了点）を追加。金額変更は全期間遡及または当日分割を明示選択し、ルール削除時も既起票事実を保持する。既存 v5 はアプリ内で読み替えず、リポジトリ外の単発変換で開始日と由来整合を確定してから取り込む。ストア構成は不変のため DB_VERSION 6 を据え置く。 |
| **v6→v7**（2026-08-10・概念整理）              | **予定キャッシュフロー（`CashflowSchedule`）の全廃**（型・`cashflowSchedules` ストア・export フィールド・予定 CRUD/実績化 API を撤去。「予定」= 未来日付の通常仕訳へ一本化し、資金繰りは導出込み仕訳〔未来仕訳 + ルール投影〕から投影する。DB_VERSION 7）。**`MonthlyCostItem.allocationStartDate?`（費用化の開始日）を追加**（未設定 = 購入日。月割りの起点と配分月数上限の基準）。**差引形ルール（行き先 = 収入カテゴリ）も台帳経由の正規形へ**（`spreadExpenseAccountId` の許容 role に `income-category` を追加・`debitAccountId` = 継続コスト台帳）。`Account.repaymentAccountId` / `repaymentDay` は返済計画シートの既定として保持。実データの変換はリポジトリ外の単発変換（アプリ内 migration なし）。 |
| **v7→v8**（2026-08-11・CSV 取込）              | **CSV 取込（Import Profile）を追加**。`importProfiles` / `profileBindings` / `importDecisions` の 3 ストア（DB_VERSION 8）と交換 JSON の 3 必須配列、`EntryMetadata` の取込由来（`importSource` ほか）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **v8→v9**（2026-08-11）                        | 取込プロファイルのアーカイブ（`ImportProfile.archived`）・上書き保存の廃止・`ProfileBinding.importFromDate`（取込開始日）。ストア構成は不変（DB_VERSION 9 は版対応を 1:1 に保つために上げた）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **v9→v10**（2026-08-11・CSV 取込の全撤去）     | **CSV 取込一式を撤去**（実ユーズの結論・作者決定 2026-08-11。「ざっくり登録して差額は残高補正で吸収」の使い方に明細単位の CSV 取込は合わない＝使わない死荷重）。v8〜v9 の型・schema・store 参照・UI・交換 JSON の 3 配列・`EntryMetadata` の取込由来を削除（DB_VERSION 10。upgrade は旧 3 ストアを温存 = 黙って削除しない）。設計は git 履歴に残る（将来要望が出たら再導入可能）。                                                                                                                                                                                                                                                                                                                                                              |

### `MonthlyCostItem`（継続コスト資産）

`id` / `name` / `amount`（購入額・正の整数）/ `startDate`('YYYY-MM-DD'・**購入の仕訳の日付と
完全一致**) / `endDate?`（任意。未設定 = 費用の割り振りをしない）/
`allocationStartDate?`（費用化の開始日・任意。未設定 = 購入日。月割りの起点で、不変条件は
`startDate ≤ allocationStartDate`〔endDate 設定時は `≤ endDate`〕。購入日〜費用化開始の間は
台帳に価値が置かれたままになる）/ `expenseAccountId`（計上先）/ `createdAt` / `updatedAt`。

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
`spreadExpenseAccountId?`（正規化済みの費用の行き先）/
`debitAccountId`（費用ルールでは継続コスト台帳、費用以外では行き先）/ `creditAccountId` / `startMonth`
（周期の位相 anchor）/ `startDate`（存在開始日・含む・必須）/ `splitFromRuleId?`（金額分割の直前 segment）/
`endDate?`（存在終了日・含まない）/
`postedThroughMonth?`（起票カーソル）。

- 存在期間は半開区間 **`[startDate, endDate)`**。`startDate` は必須で、`endDate` がある場合は
  開始日より後でなければならない。
- `startMonth` は `everyMonths` の周期の位相だけを決め、存在期間とは独立する。起票日が存在期間内に
  入るときだけ catch-up・未来投影の対象になる。
- 終了は `endDate=today` として表す。同じ設定をもう一度使う操作では、金額・周期・位相・フローを
  引き継ぎ、`startDate=today`・`endDate` なしの独立したルールを作る。id・時刻・起票カーソル・
  `splitFromRuleId` は引き継がない。
- 金額の遡及変更は、同じ `rule.id` が自動生成した全保存仕訳・item の金額を、利用者が手編集した月も
  含めて新額へ同一トランザクションで揃える。これは登録金額を最初から訂正するために利用者が選ぶ
  明示操作であり、生成済み item を通常編集で書き換えない原則の例外である。
- 今日からの金額変更は旧ルールを `endDate=today`、新しい id の後継ルールを `startDate=today` として
  分割する。今日以降にすでに起票された仕訳・item は後継へ移管し、今日より前の事実は旧ルールに残す。
  移管時に変更するのは由来 ID と今回選択した金額だけで、個別編集済みの摘要・科目・item の名称・
  期間・月割り先は保持する。後継の金額以外の設定は次の未起票回から適用する。`startMonth` の位相は
  後継へ引き継ぐため、分割日と起票日は別の概念である。
- 分割後継は `splitFromRuleId` で直前 segment を指す。同じ連鎖の全ルールは、半開存在期間どうしが
  重ならないことだけを系譜の不変条件とする。境界間の空白、開始点・終了点・周期位相の変更は
  非重複を守る限り許可する。削除した segment を指す残存後継の `splitFromRuleId` は、同一
  transaction で剥がす。
- ルール削除は、起票済みの仕訳・item を削除しない。ルールへの由来参照を同一トランザクションで
  剥がし、仕訳の `rec-{ruleId}-{month}` と item の `ccr-{ruleId}-{month}` を通常 ID へ付け替える。
  反転仕訳の `reversalOfEntryId` も同じ transaction で更新して独立した事実にした後、
  ルールだけを削除する。
- 「今日から」の分割は、旧ルールが今日より前に少なくとも1日存在し、今日も存在期間内にある場合だけ
  選択できる。開始前・開始当日・終了後は空の旧 segment を作らず、全期間変更だけを許可する。

schema v7 の月割りするルール（費用ルールと**差引形**ルール = 行き先の role が
`expense-category` / `income-category`）は `spreadExpenseAccountId` = 計上先、
`debitAccountId` = 継続コスト台帳の正規形だけを受理する。spread なし・debit が計上先の
旧形式はアプリ内で読み替えず、リポジトリ外の単発変換で正規化してから取り込む。
通常の収入ルール（行き先 = 借方が資金側）・振替/積立ルールは従来どおり直接起票する。

### `Tag`（分析タグ）

`id` / `name` / `scope`（`'entry'` のみ＝仕訳全体。明細タグは廃止）/ `color?` / `archived`。

### 予定（v7 で専用実体を全廃）

- **「予定」= 未来日付の通常仕訳**。専用の型・ストア・実績化フローは存在しない
  （`CashflowSchedule` は v7 で全廃）。資金繰り画面は導出込み仕訳
  （`reportEntriesForAsOf` を表示終了日まで展開 = 未来日付の実仕訳 + 継続コストの導出行 +
  定期ルールの投影）から将来残高・最低残高を投影する。

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
  `role` は `type` と整合する。export 日時点で終了済みでない科目名は trim 後で重複不可
  （未来の終了点を持つ科目はまだ有効として扱う）。
- 勘定科目の明示された存在期間は、その科目が関与する全仕訳日、
  継続コスト item の期間、定期ルールの未起票期間を包含する。端点未設定の JSON では
  `createdAt` を import 拒否の下限には使わず、既存データをそのまま受理する。
- 内部集約ロールは唯一の集約口座のみ（`continuing-cost-asset` = `continuing-cost-ledger`）。
- **継続コスト資産の不変条件**:
  - 各 item に**購入の仕訳がちょうど 1 件**（`metadata.monthlyCostId === item.id`・recovery なし）。
    `monthlyCostId` を持つ仕訳の参照先 item が存在する。
  - 購入の仕訳の形: 借方 = 継続コスト台帳、貸方 = 内部集約・残高調整以外の全 role
    （`RECURRING_POSTABLE_ROLES`。equity=初期残高・収入カテゴリも可）、金額 == `item.amount`、
    **`date === item.startDate`（日レベル）**。
  - **台帳に触れる保存仕訳は必ず `monthlyCostId` を持つ**（購入の仕訳 / 回収の振替の 2 種類だけ）。
  - 回収の振替は貸方 = 台帳・**借方 ≠ 台帳（自己振替禁止）**・借方 role は
    `RECURRING_POSTABLE_ROLES`（内部集約・残高調整以外の全 role）・**`date >= item.startDate`**
    （回収額の上限は設けない＝割り振る総額が負になってよい）。
    導出時の回収額は基準日までではなく、現在保存されている全実仕訳から集計する。表示する実仕訳と
    仮想月割り行の日付は `asOf` までに切るため、後日の回収は月割りへ遡及するが回収仕訳自体は過去へ現れない。
  - `endDate?` は `>= startDate`・配分月数（費用化開始月〔`allocationStartDate ?? startDate`〕〜
    終了月）≤ 1200 ヶ月。`allocationStartDate?` は `startDate` 以上・（endDate 設定時）`endDate`
    以下。`expenseAccountId` は内部集約・残高調整以外（`isRecurringPostableRole`）。
  - ルール由来 item の配分期間は、後から周期を変更して生まれた item と重なってよい。同じルール・
    同じ起票月の二重生成は、決定的 ID と起票カーソルで防ぐ。
- `endDate` を持つ**資産・負債**は、その終了点で導出仕訳込みの残高が 0 でなければならない。
  保存境界と import schema の双方で検証する。費用・収入の累計は「過去に起きたこと」の記録なので
  残高 0 を要求せず、そのまま終了できる。
- 定期ルール: `everyMonths` は 1〜1200（配分月数の上限と同じ）。論理的な行き先が費用なら
  **周期にかかわらず**借方 = 継続コスト台帳として item と対で起票する。費用以外は行き先へ
  直接起票する。定期ルール由来の仕訳は `recurringRuleId`/`recurringMonth`
  をペアで持ち、ルールが存在し、同ルール・同月の重複が無い。`startDate` は必須で、`endDate` は
  開始日より後の exclusive endpoint であることを検証する。起票月の日付がルールの半開存在期間に含まれ、
  参照科目の存在期間にも含まれることを保存境界・import の双方で確認する。
  `splitFromRuleId` で連なる同一系譜では、ルールの半開存在期間どうしが重ならないことを保存境界・
  import の双方で検証する。
  catch-up はルール単位で検証・起票し、1 本の失敗で他のルールを止めない。失敗したルールは
  書き込まずに飛ばして処理を続け、画面には個別データを含めない共通警告を出す。
  金額の遡及変更、今日での segment 分割、削除時の由来解除は、ルール・仕訳・item・revision を
  単一 readwrite transaction で更新し、途中状態を保存しない。
- 残高補正: `delta === actualBalance − expectedBalance`・対象/相手科目の存在と形・kind=normal。
- タグ: id 一意・参照整合。

### revision の原子性

本体の変更と `meta.revision` の +1 は **同一 IndexedDB トランザクション** で行う
（`repository.writeWithRevision`）。途中失敗で「本体だけ変わって revision が進まない」状態を
作らない。CAS は revision 単独ではなく **`deviceId + revision`** を台帳世代として照合する。
全初期化で revision が 0 に戻っても deviceId が変わるため、初期化前のタブからの古い保存は
通らない。revision は safe integer に限定し、上限では丸めず保存全体を中断する。

同一タブの変更 API は、事前読込から保存完了までリポジトリ境界で直列化する。操作開始時の
`deviceId + revision` を固定するため、二重操作の途中で別の保存や import が tracker を進めても、
古い検証結果を新 revision へ乗せ替えない。

export / import前スナップショットに使う台帳全体は、meta と全本体 store を **単一 readonly
transaction** で読み、別タブの複数 store 書込みと交差した中間状態を作らない。
スナップショット保存も、読取り時の `deviceId + revision` と現在の meta を `kv` +
`snapshots` の同一 transaction で照合してから行う。全初期化と競合した場合は保存を中断し、
初期化後へ旧世代のスナップショットを復活させない（スナップショット保存自体は revision を
進めない）。

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

step 4 で見た `deviceId + revision` は step 5 の保存 transaction でも再照合し、その後の
置換 transaction まで固定する。確認後に別タブが保存・全初期化した場合は force なしで新状態を
上書きせず、中断する。force 時も step 5 のスナップショット時点を置換 CAS の基準にする。

復元（`restoreFromSnapshot`）も同様に、復元前スナップショットを取ってから原子的に置換する。
`schemaVersion` 不一致のスナップショットは復元不可で、起動時に自動削除される（版上げ直後に
「使えるように見えて復元できない」スナップショットを並べない）。

## migration ポリシー（後方互換をコードで持たない）

- `schemaVersion` を必ず持つ。現行は **`10`**（`SCHEMA_VERSION`・`src/data/constants.ts`）。
- **アプリ内に migration チェーンを持たない**（作者決定・単発変換方式）。版を上げたら:
  1. `SCHEMA_VERSION` を +1 する（旧版 JSON / スナップショットは fail-closed に拒否される）。
  2. 実データは書き出した JSON を**単発の変換スクリプト**（`_workspace-management/scripts/`）で
     新版へ変換し、新ビルドに import する。変換結果は必ず `ledgerExportPackageSchema` に通す。
  3. ストア構成が変わるときだけ `DB_VERSION` を上げる。upgrade は「不足ストアの作成だけを行う」
     冪等な形で、**現行 STORE に無い旧版ストアは温存する**（`src/data/db.ts`。旧版 DB は
     schemaVersion 検査で復旧面へ送られ、旧版データは復旧面の「DB 初期化」= DB 削除でのみ消える
     ＝黙って削除しない）。
- 未対応版は **fail-closed**（取り込まない）。復旧面はルート直下の ErrorBoundary
  （JSON import / DB 全消去の 2 ボタン）が受ける。
- 2026-07-31 の定期ルール線分化は保存形式を厳格化するため `SCHEMA_VERSION=6` へ上げる。
  ストア構成は変えないので `DB_VERSION=6` は据え置く。v5 の未設定開始日をアプリ内で推測せず、
  期間外の起票、orphan の `ccr` item、由来のない購入仕訳とともに fail-closed に拒否する。
- 2026-08-10 の概念整理（予定 CF 全廃・`allocationStartDate`・差引形 spread 正規形）は
  `SCHEMA_VERSION=7` / `DB_VERSION=7`。v6 以前の JSON は unsupported-version、v6 以前の DB は
  復旧面へ（in-app 変換なし）。
- 2026-08-11 の CSV 取込の全撤去（v8〜v9 で足した機能ごと）は `SCHEMA_VERSION=10` /
  `DB_VERSION=10`。v9 以前の JSON は unsupported-version、v9 以前の DB は復旧面へ
  （in-app 変換なし。旧 3 ストアは upgrade で温存し、復旧面の「DB 初期化」でのみ消える）。

## 外部送信ゼロとの関係

- export はブラウザ内で `Blob` + `blob:` URL を生成してダウンロードするだけ（外部送信なし）。
- import はユーザーが選んだローカルファイルを `File.text()` で読むだけ（外部送信なし）。
- 同期・送信機能はアプリに持たない（[ADR 0001](../adr/0001-local-first-ledger.md)）。
