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

## 按分支出（長期の生活コスト）

高額・長期の支出（例: PC 240,000 円 / 48 か月）を月割りで費用認識する。実装は
`src/domain/allocation.ts` と `AllocationItem`（`src/domain/types.ts`）。

仕訳生成（すべて 2 行・単一トランザクションで保存。`repository.createAllocation`）:

- **原始仕訳**（購入時・費用にしない）: `借方 按分中資産(deferred) / 貸方 支払元(payment)` … 総額
- **月次認識仕訳 ×months**: `借方 費用カテゴリ(expense) / 貸方 按分中資産` … 総額 ÷ months
  - 端数は **合計が必ず総額に一致** するよう先頭月から 1 円ずつ配分（`monthlyAmounts`）。
  - 各仕訳の日付は開始月（＝支出日の月）から 1 か月ずつ。`metadata.allocationId` /
    `allocationRole`（`source`/`recognition`）を持つ。

これにより PL/BS は変更不要のまま、月次認識仕訳が各月の費用として自然に集計される
（生活コスト = 通常費用 + 按分認識額）。

- **按分中資産**（繰延）科目は初回利用時に asset 科目として自動作成し、以後再利用。
- 生成仕訳は **通常の編集・削除では壊せない**（`metadata.allocationId` を持つ仕訳は fail-closed）。按分台帳で管理する。
- 完了（全認識月が経過）は現在月から導出し、台帳の既定表示から外す。**物理削除はしない**。

#### 現在表示は必ず「今日時点」で切る（未来は予定）

未来月の認識仕訳を事前生成する方式のため、現在の集計表示は as-of で切る:

- **BS** は基準日（既定=今日）で導出（`deriveBalanceSheet(..., asOf)`）。未来月の認識を現在残高に
  含めない。Dashboard は今日、Statements は基準日入力（既定=今日）。
  → 120,000 円/12 か月なら、当月 BS では `按分中資産` に未認識残高（例 110,000）が残る。
- **Journal** の既定表示は今日まで（未来の認識仕訳を隠す）。「将来予定も表示」で確認できる。
- 完了ラベルは **「認識完了」**。クレカ等（負債）支払いでは費用認識完了 ≠ 返済完了。

### 期間按分プラン（`metadata.allocationPlan`）

別系統の将来拡張点（前払/前受の期間按分）。型・スキーマ・検証のみ用意し、UI と生成は未実装。

## 残高補正（「締め」なし）

実残高との差分を任意の日に補正する（`src/domain/adjustment.ts`、`metadata.adjustment`）。
**月次/年次の「締め」やロックは作らない**。集計は日付範囲から自動で行い、過去日付の入力・修正も許可する。

- `unknown-balance`: 通常の現金/預金差額 → `残高調整費` / `残高調整収入`（初回利用時に自動作成・再利用）。
- `investment-valuation`: 投資残高差額 → `投資評価損` / `投資評価益`。
- 理論残高 = その日付までの仕訳から導出した残高。`delta = 実残高 − 理論残高`。`delta=0` は仕訳を作らない。
- 仕訳の向き（2 行のみ）:
  - asset 増: `借方 資産 / 貸方 収入(評価益)` ／ asset 減: `借方 費(評価損) / 貸方 資産`
  - liability 増: `借方 費 / 貸方 負債` ／ liability 減: `借方 負債 / 貸方 収入`
- **投資評価損益は生活コストに含めない**（Dashboard の生活コスト合計から除外して表示）。残高調整費/収入は
  「調整」として見えるようにし、通常費用に完全には埋もれさせない。補正を毎回「元入金」にはしない。

## タグ（分析軸）

勘定科目を増やさずに、旅行・イベント・カード名・銀行名などを後から抽出する分析軸（`src/domain/tags.ts`、
`Tag`）。**PL/BS の会計ロジックは変えない**。

- **全体タグ**（`scope: entry|both`）= `JournalEntry.tagIds`（旅行・学会・プロポーズ 等）。
- **明細タグ**（`scope: line|both`）= `JournalLine.tagIds`（楽天カード・楽天銀行 等、借方/貸方側に付く）。
- 予定 CF にもタグ欄（`entryTagIds`/`accountLineTagIds`/`counterLineTagIds`）を持ち、実績化時に仕訳へコピー。
- Journal はタグで絞り込み・タグチップ表示。タグ画面は作成/改名/アーカイブ + 期間集計
  （全体タグ=合計、明細タグ=借方計/貸方計。例: 楽天カードと楽天銀行の貸方計を比較）。
- 参照中タグの物理削除は禁止（アーカイブ）。タグ未入力はエラーにしない。
- 楽天カード/楽天銀行などを**勘定科目として自動作成しない**（タグで扱う）。

## 将来キャッシュフロー（資金繰り）と目的別資金

「いつ費用認識するか(按分)」と「いつ現金が動くか(CF)」は**別概念**として保存する
（`src/domain/cashflow.ts`、`CashflowSchedule` / `ReserveItem`）。

- **`CashflowSchedule`**: 将来の入出金予定。`planned` を期日順に適用して自由資金の推移・最低残高を
  投影する（`projectCashflow`）。予定は仕訳一覧へ大量生成しない。**実績化**で 1 件の 2 行仕訳を作り、
  `posted` にする（単一トランザクション）。outflow: `借方 counter / 貸方 account`。
- **クレカ/分割払い**は自動ルールではなく、まず予定 CF として手入力/明示指定で扱う。一括=1 件、
  分割=N 件（端数は先頭月配分）。締め日/支払日の自動計算・カード会社別ルール・ボーナス払いは次フェーズ。
- **目的別資金（`ReserveItem`）**: 取り置きは通常の振替（普通預金 → 目的別資金）で行い、資金繰りでは
  その残高を**自由資金から除外**して見る（総資産は不変）。例: 結婚資金 70 万を取り置くと自由資金が
  70 万減る。
- 生活コスト按分の月数と、負債返済の回数は**別概念**（同じ `months` に混ぜない）。

### 次フェーズ（未実装）

資産売却・一括返済（返済スケジュールの自動化）・クレカ締め日ルールは今回実装しない。売却損益は
複数仕訳が必要で 2 行仕訳制約と衝突しやすいため。支払元が liability（クレカ等）の場合も、按分の費用
認識（いつ費用にするか）と返済（いつ現金が出るか＝資金繰りの予定 CF）は分けて扱う。

## 勘定科目の変更ルール（`Account`）

- 名前変更: 同一 `id` の表示名を変える。過去仕訳も新名称で表示。
- 新規追加: 以後の科目として追加。
- 物理削除: **未使用のみ可**（仕訳から参照中は不可・アーカイブを使う）。
- 区分(type)変更: **未使用のみ可**（使用中は禁止）。UI で無効化し、`upsertAccount` でも fail-closed。

## 関連

- データ形式・import ポリシー: [ledger-protocol.md](ledger-protocol.md)
- 画面/UX: [ledger-ui-ux.md](ledger-ui-ux.md)
- 設計判断（ローカルファースト）: [../adr/0001-local-first-ledger.md](../adr/0001-local-first-ledger.md)
