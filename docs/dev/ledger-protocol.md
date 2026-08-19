# simple-ledger — データ形式と import ポリシー

実装: `apps/simple-ledger/src/domain/schema.ts`（Zod）、
`apps/simple-ledger/src/data/exportImport.ts`、`apps/simple-ledger/src/data/repository.ts`。

## 保存方針

- **実行時の正本 = IndexedDB**（`DB_NAME = "simple-ledger-v2"`）。ストア:
  `kv`（meta / settings）、`accounts`、`journalEntries`、
  `tags`（タグ機能は 2026-08-15 に撤去。受理のみ = 旧ストア温存の方針で残す）、
  `monthlyCostItems`、`recurringRules`、`snapshots`
  （v7 で `cashflowSchedules` を全廃。「予定」= 未来日付の通常仕訳）。
- **公式交換形式 = JSON**（端末間共有・バックアップ）。JSON をDB代わりに常用しない。
- **計算で生まれる仕訳は保存しない**: 持ち物の費用の行・ルールの未来投影は
  `reportEntriesForAsOf` が表示のたびに展開する導出専用で、IndexedDB / export / スナップショットの
  どこにも書かれない（`assertEntrySavable` が `metadata.virtual` 付き仕訳の保存を例外で拒否する）。

### 表示名と識別子は別物（v13.1・2026-08-16）

表示語彙を「継続コスト」→「**月割り**」へ改名した（画面・文書では **月割り台帳** /
**持ち物** / **月割り**）。**改名したのは表示文字列と文書だけで、保存・交換に出る識別子は
一切変えていない**: well-known 科目 ID `continuing-cost-ledger`、role
`continuing-cost-asset`、ルール由来 item の ID 接頭辞 `ccr-`、導出仕訳の
`ccKind`（`funding` / `monthly-allocation`）、export フィールド名 `monthlyCostItems`、
仕訳メタの `monthlyCostId` / `monthlyCostRecovery`、ルールの `spreadExpenseAccountId` は
すべて据え置き。したがって旧版の JSON は改名後もそのまま読め、書き出した JSON を旧版へ
戻すこともできる（schema バージョンは上がらない）。集約台帳の `Account.name` は利用者データ
なので既存台帳では旧名のまま残り、新しく find-or-create される科目だけが既定名
`月割り台帳`（`CONTINUOUS_COST_LEDGER_ACCOUNT_NAME`・定数名は不変）になる。

## JSON export パッケージ

`LedgerExportPackage`（`src/domain/types.ts` / `schema.ts`）:

```jsonc
{
  "appId": "snishi-code.simple-ledger-v2",
  "schemaVersion": 13,
  "ledgerId": "ledger",
  "exportedAt": "2026-07-29T00:00:00.000Z",
  "deviceId": "<uuid>",
  "revision": 12, // foundation 封筒の revision（楽観的衝突検出）
  "accounts": [
    /* Account[]（type + role 付き） */
  ],
  "journalEntries": [
    /* JournalEntry[]（保存される仕訳のみ。未来日付の仕訳 = 「予定」もここに入る。
       ルール由来（rec- / 由来メタ）は保存されない = 含まれていたら invalid・v13） */
  ],
  "monthlyCostItems": [
    /* MonthlyCostItem[]（持ち物） */
  ],
  "recurringRules": [
    /* RecurringRule[]（定期ルール） */
  ],
  // currency は表示に後置する単位文字列（1〜8 文字・通貨コードではない・換算しない）。
  // displayFractionDigits は表示と入力の刻みだけを決める（保存・計算は常に 1/100 固定）。
  "settings": { "ledgerName": "家計簿", "currency": "円", "displayFractionDigits": 0 },
}
```

- `Account.role`: `type` と整合する UI 用役割（`daily-asset` /
  `investment-asset` / `continuing-cost-asset`（内部集約＝月割り台帳）/ `payment-liability` /
  `other-liability` / `equity` / `income-category` / `expense-category` / `system-adjustment`）。
  詳細は [ledger-concept.md](ledger-concept.md#中核モデル)。import 検証で `role` と `type` の
  整合も確認する。
- `Account.movable?`（「自由に動かせる」）: `daily-asset` のみ・**保存されるのは `false` だけ**
  （ON = 既定は `undefined`。`true` や `daily-asset` 以外に付いた値は import 時に strip /
  剥がして自己修復する）。資金繰りの原資の判定にだけ使う。
- `Account.startDate?` / `endDate?`: 勘定科目が時間軸上に存在する両端（`YYYY-MM-DD`・両端を含む）。
  `startDate` **未設定 = 過去へ開いた線分**（過去側制限なし・§A 案1 2026-08-11。旧
  「`createdAt` を暗黙開始日とみなす」は廃止）。新規作成（初期残高付きを含む）の既定も空欄で、
  作者が科目編集で明示したときだけ保存される。
  終了操作は今日を `endDate` に記録し、終了の解除は `endDate` を消す。
  schema / DB の版は変えず、端点のない JSON も受理する。
- `JournalEntry.groupId?`: 諸口（複数フロー行の束・グループ ID 方式）の**予約フィールド**（v12。
  検証は形式のみ〔1〜64 文字〕で、UI・集計は未実装。同 groupId の件数など相互参照の不変条件は
  持たせない）。
- `revision`: 端末ローカルの編集追跡。保存のたびに +1。
- 金額（`JournalLine.amount`）は **正の整数・1/100 単位（minor）**（v11〜。例: 1,234.56 → 123456・
  100円 → 10000）。通貨はただの単位文字列で、表示の小数桁は `settings.displayFractionDigits`
  （0|1|2・既定 0）が決める（保存・計算は常に 1/100 固定）。

### schemaVersion の変遷（simple-ledger-v2。appId `snishi-code.simple-ledger-v2`）

> 旧 v1 アプリ（v1〜v16）の歴史は版 1 に畳んだ。**後方互換をコードで持たない**（作者決定）＝
> migration step を追加せず、旧版 JSON は unsupported-version で fail-closed に拒否し、
> 実データは単発の変換スクリプトで前進させる（下記）。

| 版                                             | 変更                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v1**                                         | v1 アプリの最終形（旧 v16 相当）を版 1 として開始（レガシー migration なし）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **v1→v2**（2026-07-28）                        | 使われていなかった 2 概念を型・schema・store・UI ごと撤去。IndexedDB は DB_VERSION 3 の upgrade で旧ストアを削除。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **v2→v3**（2026-07-29・指示書#4）              | 廃止概念の一掃（`fixed-asset` / `deferred-asset` role・按分 `allocations`・投資評価損益）・補正の通常化・並び順の正本化・ヘッダーの日付選択化・用語統一。旧 `allocations` ストアを削除（DB_VERSION 4）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **v3→v4**（2026-07-30・指示書#5）              | **持ち物の4項目モデル一本化**。`MonthlyCostItem` を 8 フィールド化（`startDate`/`endDate?`。`kind`/`costMonths`/`repeatEveryMonths`/`startMonth`/`endMonth`/`paymentSourceAccountId`/`recognitionCreditAccountId`/`status` 等を撤去）。**購入の仕訳を保存される仕訳にする**（`metadata.monthlyCostId`）。回収の振替（`metadata.monthlyCostRecovery`）を追加。`AssetDisposal`（処分）・一時停止・実績動的償却を全廃（`assetDisposals` ストア削除。DB_VERSION 5）。`RecurringRule` に `everyMonths`（必須）と `spreadExpenseAccountId?`（月割りするルール）を追加。科目名「開始残高」→「初期残高」。実データの変換 = `_workspace-management/scripts/convert-ledger-v3-to-v4.mjs`（単発・アプリ内 migration なし）。                    |
| **v4→v5**（2026-07-30・実ユーズレビュー第2弾） | **取り置きの機能ごと全廃**（`reserves` ストア・`ReserveItem`・`metadata.reserveId`・role `reserve-asset`・予定 CF の `source:'reserve'` を撤去。DB_VERSION 6）。**`Account.movable?`（「自由に動かせる」・現預金のみ・`false` だけ保存）を追加**（資金繰りの原資 =「自由に動かせるお金」1 値）。**支出ルールは周期にかかわらず常に台帳経由**（月割りするルールの条件 `everyMonths >= 2` を撤廃・`>= 1`。簿記編集ルールにも月割りを開放し、購入の仕訳の貸方・ルールの源泉/費用の行き先は内部集約・残高調整以外の全 role = `RECURRING_POSTABLE_ROLES`）。過去に起票済みの支出形ルール由来の仕訳も変換で台帳経由へ揃えた。実データの変換 = `_workspace-management/scripts/convert-ledger-v4-to-v5.mjs`（単発・アプリ内 migration なし）。 |
| **v5→v6**（2026-07-31・定期ルール線分化）      | `RecurringRule.startDate`（存在開始日・必須）と `endDate?`（排他的終了点）を追加。金額変更は全期間遡及または当日分割を明示選択し、ルール削除時も既起票事実を保持する。既存 v5 はアプリ内で読み替えず、リポジトリ外の単発変換で開始日と由来整合を確定してから取り込む。ストア構成は不変のため DB_VERSION 6 を据え置く。 |
| **v6→v7**（2026-08-10・概念整理）              | **予定キャッシュフロー（`CashflowSchedule`）の全廃**（型・`cashflowSchedules` ストア・export フィールド・予定 CRUD/実績化 API を撤去。「予定」= 未来日付の通常仕訳へ一本化し、資金繰りは導出込み仕訳〔未来仕訳 + ルール投影〕から投影する。DB_VERSION 7）。**`MonthlyCostItem.allocationStartDate?`（費用化の開始日）を追加**（未設定 = 購入日。月割りの起点と配分月数上限の基準）。**差引形ルール（行き先 = 収入カテゴリ）も台帳経由の正規形へ**（`spreadExpenseAccountId` の許容 role に `income-category` を追加・`debitAccountId` = 月割り台帳）。`Account.repaymentAccountId` / `repaymentDay` は返済計画シートの既定として保持。実データの変換はリポジトリ外の単発変換（アプリ内 migration なし）。 |
| **v7→v8**（2026-08-11・CSV 取込）              | **CSV 取込（Import Profile）を追加**。`importProfiles` / `profileBindings` / `importDecisions` の 3 ストア（DB_VERSION 8）と交換 JSON の 3 必須配列、`EntryMetadata` の取込由来（`importSource` ほか）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **v8→v9**（2026-08-11）                        | 取込プロファイルのアーカイブ（`ImportProfile.archived`）・上書き保存の廃止・`ProfileBinding.importFromDate`（取込開始日）。ストア構成は不変（DB_VERSION 9 は版対応を 1:1 に保つために上げた）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **v9→v10**（2026-08-11・CSV 取込の全撤去）     | **CSV 取込一式を撤去**（実ユーズの結論・作者決定 2026-08-11。「ざっくり登録して差額は残高補正で吸収」の使い方に明細単位の CSV 取込は合わない＝使わない死荷重）。v8〜v9 の型・schema・store 参照・UI・交換 JSON の 3 配列・`EntryMetadata` の取込由来を削除（DB_VERSION 10。upgrade は旧 3 ストアを温存 = 黙って削除しない）。設計は git 履歴に残る（将来要望が出たら再導入可能）。                                                                                                                                                                                                                                                                                                                                                              |
| **v10→v11**（2026-08-13・金額の 1/100 単位化） | **全金額 ×100（minor 単位）**・`settings.locale` 撤去・`settings.displayFractionDigits`（表示桁数 0\|1\|2・入力の刻み連動）新設・snapshot `reason` の理由コード化・`amountSchema` に上限 10^12 追加（集計 overflow ガード = `domain/safeSum` と対）。導出（月割り・投影・返済分割）は minor をそのまま扱い 1 単位へ丸め直さない（表示の丸めは表示層のみ）。実データは単発変換（DB_VERSION 11）。 |
| **v12→v13**（2026-08-16・完全導出） | **ルール由来の保存を全廃**（`rec-` 仕訳・`ccr-` item・`postedThroughMonth`。wire では invalid・アプリはルール線分から毎回導出）。**`RecurringRule.settlements`（清算）を新設**（ルール由来 item の早期終了の上書き。回収は実仕訳のまま）。**タグをフィールドごと削除**（`tags` / `tagIds`）。編集 = 全期間の引き直し / 切り替え = 半開区間の境界（切り替えシート + 清算）。実データの変換 = `_workspace-management/scripts/convert-ledger-v12-to-v13.mjs`（単発・アプリ内 migration なし。DB_VERSION 13）。 |
| **v11→v12**（2026-08-15・月割りの同日刻み）  | **費用化を同日刻みへ**（支払いが買った期間を同日刻みで n 等分し、各刻みの終端の日に費用化する。`allocationSchedule` が正本）。ルール由来 item（`ccr-{ruleId}-{YYYY-MM}`）の `endDate` の意味を「周期末の月末」から**「次回起票日と同日」**へ変更（単発変換で書き換える）。**`MonthlyCostItem.allocationStartDate` を撤去**（機能ごと廃止）。**残高補正を全科目へ開放**（`asset`/`liability` に加え `expense`/`revenue`。向きは借方正規/貸方正規の 2 分岐へ一般化）。**ルールの台帳経由を登録時の明示トグル化**（role で動作を決めない。`spreadExpenseAccountId` の許容先を起票できる全 role = `RECURRING_POSTABLE_ROLES` へ拡大）。**`JournalEntry.groupId?` を予約**（諸口・形式検証のみ・UI 未実装）。実データの変換 = `_workspace-management/scripts/convert-ledger-v11-to-v12.mjs`（単発・アプリ内 migration なし。DB_VERSION 12）。 |

### `MonthlyCostItem`（持ち物）

`id` / `name` / `amount`（購入額・正の整数）/ `startDate`('YYYY-MM-DD'・**購入の仕訳の日付と
完全一致**) / `endDate?`（任意。未設定 = 費用の割り振りをしない）/ `expenseAccountId`（計上先）/
`createdAt` / `updatedAt`。

- **購入の仕訳**（保存される仕訳・item と 1:1）: `借方 月割り台帳(continuing-cost-ledger) /
貸方 支払い元`。印は `metadata.monthlyCostId` のみ。持ち込み登録（貸方 = 初期残高 equity）は
  `kind:'opening'`。
- **回収の振替**（終了時の売却・返金）: `借方 回収先 / 貸方 月割り台帳`・
  `metadata: { monthlyCostId, monthlyCostRecovery: true }`。普通のユーザー入力の振替として
  編集・削除可。`archiveMonthlyCost` は `recoveries`（0 本以上）を同一トランザクションで保存する。
  終了シートが作るのは最大 2 本 = ①回収先への回収 ②「残りを終了日に全額費用にする」の
  第 2 振替（借方 = `item.expenseAccountId`・金額 = 残存価値 − 回収額）。第 2 振替も回収の一種
  なので、**台帳にふれる保存仕訳は購入と回収の 2 種だけ**という不変条件は変わらない。
  保存境界は費用カテゴリ宛ての回収を `item.expenseAccountId` に限る（それ以外の費用科目は
  `error.monthlyCost.recoveryDestination` で拒否・fail-closed）。schema / import 側はこの絞りを
  かけない（既存データの受理は変えない）。
- 費用の行は保存されない（`continuousCostEntriesForItem` が展開する）。
- **ルール由来はまるごと保存されない**（v13・完全導出）: 起票仕訳 `rec-{ruleId}-{month}` と
  item `ccr-{ruleId}-{YYYY-MM}` はルール線分から毎回導出される決定的な名前で、wire に
  含まれていたら invalid。回収の振替の `monthlyCostId` が `ccr-…` を指す場合、参照整合は
  「そのルールがその月の item を導出できるか」（spread・位相・存在期間）で検証する。
  導出 item の `endDate` は**次回起票日と同日**（清算 `settlements` があればその終了日）。

### `RecurringRule`（定期ルール）

`id` / `name` / `amount` / `dayOfMonth` / `everyMonths`（必須。1 = 毎月）/
`spreadExpenseAccountId?`（台帳経由トグルの保存表現。値 = 月割りの計上先）/
`debitAccountId`（台帳経由なら月割り台帳、直接起票なら行き先）/ `creditAccountId` / `startMonth`
（周期の位相 anchor）/ `startDate`（存在開始日・含む・必須）/ `splitFromRuleId?`（金額分割の直前 segment）/
`endDate?`（存在終了日・含まない）/
`settlements?`（清算 = ルール由来 item の早期終了の上書き `{month, endDate}[]`・v13）。

- 存在期間は半開区間 **`[startDate, endDate)`**。`startDate` は必須で、`endDate` がある場合は
  開始日より後でなければならない。
- `startMonth` は `everyMonths` の周期の位相だけを決め、存在期間とは独立する。起票日が存在期間内に
  入る月だけが導出される（カーソル・キャッチアップは存在しない。過去も未来も同じ規則）。
- 終了は `endDate=today` として表す。同じ設定をもう一度使う操作では、金額・周期・位相・フローを
  引き継ぎ、`startDate=today`・`endDate` なしの独立したルールを作る。id・時刻・
  `splitFromRuleId` は引き継がない。
- ルールの編集（過去から変更）は保存行を書き換えない。**全期間が現在のルール値で引き直される**
  （金額だけでなく周期・item の配分期間も変わる）。
- 清算（`settlements`）は月割りルール専用で、清算月は一意・そのルールが導出する月・終了日は
  起票日〜既定の終了日（次回起票日）の範囲だけを受理する。回収は実仕訳（回収の振替）。
- 今日からの金額変更は旧ルールを `endDate=today`、新しい id の後継ルールを `startDate=today` として
  分割する。今日以降にすでに起票された仕訳・item は後継へ移管し、今日より前の事実は旧ルールに残す。
  移管時に変更するのは由来 ID と今回選択した金額だけで、個別編集済みの摘要・科目・item の名称・
  期間・月割り先は保持する。後継の金額以外の設定は次の未起票回から適用する。`startMonth` の位相は
  後継へ引き継ぐため、分割日と起票日は別の概念である。
- 分割後継は `splitFromRuleId` で直前 segment を指す。同じ連鎖の全ルールは、半開存在期間どうしが
  重ならないことだけを系譜の不変条件とする。境界間の空白、開始点・終了点・周期位相の変更は
  非重複を守る限り許可する。削除した segment を指す残存後継の `splitFromRuleId` は、同一
  transaction で剥がす。
- `rec-{ruleId}-{month}` の仕訳と `ccr-{ruleId}-{month}` の item は導出値で、個別操作を持たない
  （2026-08-15）。`upsertEntry` / `deleteEntry` / `upsertMonthlyCost` /
  `archiveMonthlyCost` / `deleteMonthlyCost` は対象が由来を名乗った時点で
  `error.recurring.generatedReadOnly` を投げる。判定は由来メタ（`recurringRuleId`）と決定的 ID の
  どちらか一方でも名乗れば由来あり（過渡の保存データも読み取り専用側へ倒す・fail-closed）。
- ルール削除は**カスケード**。ルール本体を消せば導出はすべて消え、保存側では item に紐づく
  実仕訳（回収の振替）と過渡の保存 rec- / ccr- を同一トランザクションで道連れにする。
  消える・導出されなくなる仕訳を指していた反対仕訳は残し、`reversalOfEntryId` だけを
  同じ transaction で剥がす。
  回収の振替は残せない（貸方 = 月割り台帳。台帳にふれる仕訳は `monthlyCostId` 必須
  〔不変条件⑧〕で、購入の借方が消えれば台帳残高も負に落ちる）。
  終了点残高の検証は「消したあとの姿」で行う。
- 「今日から」の分割は、旧ルールが今日より前に少なくとも1日存在し、今日も存在期間内にある場合だけ
  選択できる。開始前・開始当日・終了後は空の旧 segment を作らず、全期間変更だけを許可する。

月割りする（月割り台帳を経由する）ルールは `spreadExpenseAccountId` = 計上先、
`debitAccountId` = 月割り台帳の正規形だけを受理する。spread なし・debit が計上先の
旧形式はアプリ内で読み替えず、リポジトリ外の単発変換で正規化してから取り込む。
台帳を経由するかは**登録時の明示トグル**で決まり、role では決まらない（v12。既定を ON にする
行き先 role は `expense-category` / `income-category` だが、計上先には起票できる全 role
〔`RECURRING_POSTABLE_ROLES`〕を置ける）。トグル OFF のルールは行き先へ直接起票する。
保存形はこの二形だけ。

### タグ（v13 で削除済み）

機能は 2026-08-15 に撤去し、v13 で `tags` / `JournalEntry.tagIds` をフィールドごと削除した
（v13 の zod は未知キーを strip する。旧 IndexedDB の `tags` ストアは未知レガシーとして温存され、
復旧面の DB 初期化でのみ消える）。

### 予定（v7 で専用実体を全廃）

- **「予定」= 未来日付の通常仕訳**。専用の型・ストア・実績化フローは存在しない
  （`CashflowSchedule` は v7 で全廃）。資金繰り画面は導出込み仕訳
  （`reportEntriesForAsOf` を表示終了日まで展開 = 未来日付の実仕訳 + 月割りの導出行 +
  定期ルールの投影）から将来残高・最低残高を投影する。

### `JournalEntry.metadata`（任意）

```jsonc
"metadata": {
  "inputMode": "income | expense | transfer | manual | reversal",
  "reversalOfEntryId": "<元仕訳 ID（reversal のとき）>",
  // 残高補正（現実アンカー。「締め」は作らない）。編集・削除は補正画面のみ（Journal は読み取り専用）。
  "adjustment": {
    "accountId": "<asset|liability|expense|revenue>",
    "expectedBalance": 10000,
    "actualBalance": 8000,
    "delta": -2000,            // actual − expected
    "counterpartAccountId": "<残高調整費/収入>"
  },
  // 持ち物に紐づく保存仕訳の印。recovery なし = 購入の仕訳 / あり = 回収の振替。
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
  持ち物 item の期間、定期ルールの未起票期間を包含する。端点未設定の JSON では
  `createdAt` を import 拒否の下限には使わず、既存データをそのまま受理する。
- 内部集約ロールは唯一の集約口座のみ（`continuing-cost-asset` = `continuing-cost-ledger`）。
- **持ち物の不変条件**:
  - 各 item に**購入の仕訳がちょうど 1 件**（`metadata.monthlyCostId === item.id`・recovery なし）。
    `monthlyCostId` を持つ仕訳の参照先 item が存在する。
  - 購入の仕訳の形: 借方 = 月割り台帳、貸方 = 内部集約・残高調整以外の全 role
    （`RECURRING_POSTABLE_ROLES`。equity=初期残高・収入カテゴリも可）、金額 == `item.amount`、
    **`date === item.startDate`（日レベル）**。
  - **台帳に触れる保存仕訳は必ず `monthlyCostId` を持つ**（購入の仕訳 / 回収の振替の 2 種類だけ）。
  - 回収の振替は貸方 = 台帳・**借方 ≠ 台帳（自己振替禁止）**・借方 role は
    `RECURRING_POSTABLE_ROLES`（内部集約・残高調整以外の全 role）・**`date >= item.startDate`**
    （回収額の上限は設けない＝割り振る総額が負になってよい）。
    導出時の回収額は基準日までではなく、現在保存されている全実仕訳から集計する。表示する実仕訳と
    仮想月割り行の日付は `asOf` までに切るため、後日の回収は月割りへ遡及するが回収仕訳自体は過去へ現れない。
  - `endDate?` は `>= startDate`・配分月数（購入月〜終了月）≤ 1200 ヶ月。
    `expenseAccountId` は内部集約・残高調整以外（`isRecurringPostableRole`）。
  - ルール由来 item の配分期間は、別線分から生まれた item と重なってよい。同じ月が二重に
    導出されないことは、半開区間の存在期間と系譜の非重複が保証する。
- `endDate` を持つ**資産・負債**は、その終了点で導出仕訳込みの残高が 0 でなければならない。
  保存境界と import schema の双方で検証する。費用・収入の累計は「過去に起きたこと」の記録なので
  残高 0 を要求せず、そのまま終了できる。
- 定期ルール: `everyMonths` は 1〜1200（配分月数の上限と同じ）。`spreadExpenseAccountId` を持つ
  ルール（= 台帳経由トグル ON）は**周期にかかわらず**借方 = 月割り台帳として item と対で
  起票し、持たないルールは行き先へ直接起票する（role では決まらない）。定期ルール由来の仕訳は
  `recurringRuleId`/`recurringMonth`
  をペアで持ち、ルールが存在し、同ルール・同月の重複が無い。`startDate` は必須で、`endDate` は
  開始日より後の exclusive endpoint であることを検証する。起票月の日付がルールの半開存在期間に含まれ、
  参照科目の存在期間にも含まれることを保存境界・import の双方で確認する。
  `splitFromRuleId` で連なる同一系譜では、ルールの半開存在期間どうしが重ならないことを保存境界・
  import の双方で検証する。
  導出は純関数で、参照が壊れたルールは fail-soft に飛ばす（他のルールを止めない）。
  切り替え・終了・清算・削除は、ルール・回収仕訳・revision を単一 readwrite transaction で
  更新し、途中状態を保存しない。
- ルール由来の保存拒否（v13）: `rec-` ID / 由来メタを持つ仕訳・`ccr-` ID の item は invalid。
- 残高補正: `delta === actualBalance − expectedBalance`・対象/相手科目の存在と形・kind=normal。

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

- `schemaVersion` を必ず持つ。現行は **`13`**（`SCHEMA_VERSION`・`src/data/constants.ts`）。
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
- 2026-08-13 の金額 1/100 単位化（指示書 v3）は `SCHEMA_VERSION=11` / `DB_VERSION=11`。
  **全金額フィールド ×100**（`journalLine.amount`・`recurringRule.amount`・
  `monthlyCostItem.amount`・adjustment の `expectedBalance`/`actualBalance`/`delta`。
  除外 = `annualReturnBp`・`repaymentDay`・`dayOfMonth`・`everyMonths`・`sortIndex`・回数・日付・
  `revision`）+ `settings.locale` 撤去 + `settings.displayFractionDigits`（0|1|2）新設 +
  スナップショット `reason` の理由コード化（`'import'`/`'restore'`）。
  v10 以前の JSON は unsupported-version、v10 以前の DB は復旧面へ（in-app 変換なし。
  実データの v10→v11 変換 = `_workspace-management/scripts/convert-ledger-v10-to-v11.mjs`・
  **順序固定**: v10 ビルドのまま export → 変換 → **変換結果を実 schema と実 import で検証**
  （`apps/simple-ledger/tests/convertedLedger.verify.test.ts` に `CONVERTED_LEDGER_JSON=<path>` を渡す）
  → v11 更新 → DB 初期化 → import）。
  **版を上げると旧版のスナップショットは復元できなくなる**（`schemaVersion` 不一致は
  復元不可・起動時に自動削除）。保険は「変換前の v10 JSON を手元に残すこと」であって
  アプリ内スナップショットではない。
- 2026-08-15 の月割りの同日刻み化は `SCHEMA_VERSION=12` / `DB_VERSION=12`（store 構成は
  不変だが版対応 1:1）。**ルール由来 item（`ccr-…`）の `endDate` の意味変更**（周期末の月末 →
  次回起票日と同日）+ **`allocationStartDate` 撤去** + **補正の全科目化** + **ルールの台帳経由を
  明示トグル化**（spread 先 = 起票できる全 role へ拡大）+ **`JournalEntry.groupId` の予約**。
  v11 以前の JSON は unsupported-version、v11 以前の DB は復旧面へ（in-app 変換なし。
  実データの v11→v12 変換 = `_workspace-management/scripts/convert-ledger-v11-to-v12.mjs`・
  **順序固定**: v11 ビルドのまま export → 変換 → **変換結果を実 schema と実 import で検証**
  （`apps/simple-ledger/tests/convertedLedger.verify.test.ts` に `CONVERTED_LEDGER_JSON=<path>` を渡す）
  → v12 更新 → DB 初期化 → import）。ここでも**旧版スナップショットは復元不可**なので、
  保険は変換前の v11 JSON を手元に残すこと。
- 2026-08-16 の**完全導出化**（v13）は `SCHEMA_VERSION=13` / `DB_VERSION=13`。
  **ルール由来の保存を全廃**（`rec-` 仕訳・`ccr-` item・`postedThroughMonth` を撤去し、wire では
  invalid。起票機構 = catch-up / カーソルもアプリから消滅）+ **`RecurringRule.settlements`
  （清算）を新設** + **タグをフィールドごと削除**（`tags` / `tagIds`。IndexedDB の旧 `tags`
  ストアは未知レガシーとして温存）。v12 以前の JSON は unsupported-version、v12 以前の DB は
  復旧面へ（in-app 変換なし。実データの v12→v13 変換 =
  `_workspace-management/scripts/convert-ledger-v12-to-v13.mjs`・**順序固定**: v12 ビルドの
  まま export → 変換（過去のスキップ = 線分手術・構造的逸脱 = 手動仕訳へ降格・値の逸脱 =
  導出値へ置換・早期終了 = `settlements` へ移設。すべて変換ログで目視）→
  **変換結果を実 schema と実 import で検証**（`apps/simple-ledger/tests/convertedLedgerV13.verify.test.ts`
  に `CONVERTED_LEDGER_JSON=<path>` を渡す）→ v13 更新 → DB 初期化 → import）。
  ここでも**旧版スナップショットは復元不可**なので、保険は変換前の v12 JSON を手元に残すこと。

## 外部送信ゼロとの関係

- export はブラウザ内で `Blob` + `blob:` URL を生成してダウンロードするだけ（外部送信なし）。
- import はユーザーが選んだローカルファイルを `File.text()` で読むだけ（外部送信なし）。
- 同期・送信機能はアプリに持たない（[ADR 0001](../adr/0001-local-first-ledger.md)）。
