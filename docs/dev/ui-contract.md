# simple-ledger — UI contract（テスト安定名）

テストが依存してよい **安定名** の一覧。正本は `simple-ledger-src/src/ui-contract.ts`
（`UI` オブジェクト）。各 React コンポーネントは必要最小限の `data-ui` 属性を付ける。

## ポリシー

- これらの名前は **日本語文言の変更で壊れない契約**。Playwright / Testing Library から参照する。
- **DOM 構造や CSS class には依存させない**（変更しても壊れないように）。
- Testing Library では可能な限り `getByRole` / `getByLabelText` を使う。`data-ui` は
  Playwright の主要フローや、ロール/ラベルで一意に辿れない箇所に限って使う。
- 文言の i18n キーは `src/i18n/ja.ts`。UI contract 名はそれとは別物（変えない約束）。

## `data-ui` 一覧

| 名前 | 位置 | 用途 |
|---|---|---|
| `dashboard.view` | Dashboard ルート | ホーム表示の検出 |
| `dashboard.entry.income` / `.expense` / `.transfer` | ホーム 3 ボタン | 日常入力の主導線（唯一の入力起点） |
| `dashboard.stat.revenue` / `.expense` / `.netIncome` | ホーム収支の項目別ボタン | **それぞれ別ページへ**: 収入→収入の内訳 / 支出（=通常支出+継続コスト）→支出の内訳 / 収支→収支ページ |
| `dashboard.stat.assets` / `.liabilities` / `.netAssets` | ホーム財政状態の項目別ボタン | **それぞれ別ページへ**: 資産→資産の内訳 / 負債→負債の内訳 / 純資産→純資産ページ（同じ財務諸表に集約しない） |
| `incomeBreakdown.view` / `.row` / `.total` | 収入の内訳ルート / 科目行 / 合計 | ホーム「収入」のタップ先（フロー）。行タップで仕訳へドリル。収入の推移つき |
| `expenseBreakdown.view` | 支出の内訳ルート | ホーム「支出」のタップ先。支出はホーム独立 stat にしない |
| `expenseBreakdown.normalExpense` / `.monthlyCost` / `.total` | 支出の内訳の項目 | 通常支出 / 継続コスト（タップで継続コスト台帳へ）/ 支出合計。支出の推移つき |
| `netIncome.view` / `.revenue` / `.expense` / `.result` | 収支ルート / 収入 / 支出 / 収支 | ホーム「収支」のタップ先。科目別ドリルはせず、月ごとの残り方（収支の推移）を見せる |
| `assetsBreakdown.view` / `.row` / `.total` | 資産の内訳ルート / 科目行 / 合計 | ホーム「資産」のタップ先（ストック=期間末時点）。行タップで仕訳へドリル。資産の推移つき |
| `liabilitiesBreakdown.view` / `.row` / `.total` / `.cashflowLink` | 負債の内訳ルート / 科目行 / 合計 / CF導線 | ホーム「負債」のタップ先（ストック）。`cashflowLink` で資金繰り・返済計画へ |
| `netAssets.view` / `.row` / `.total` | 純資産ルート / 元手の科目行 / 合計 | ホーム「純資産」のタップ先（ストック）。元手 + 今期の損益 + 純資産の推移 |
| `dashboard.journal.preview` / `dashboard.journal.openAll` | ホーム下部「期間内の仕訳」 | プレビュー / すべて見る（期間フィルタ） |
| `period.year.trigger` / `period.month.trigger` | ヘッダー中央の期間コンテキスト表示 | タップで年/月の軽量ピッカーを開く（全期間時は月トリガー無し） |
| `period.year.picker` / `period.month.picker` | 軽量ピッカー本体（`Popup`） | 背景タップ/Escape で閉じる。タイトル/閉じる/完了ボタン無し |
| `period.all.row` / `period.year.row` | 年ピッカーの行 | 全期間 / 各年（選択で即反映して閉じる。現在行は `aria-current`） |
| `period.fullYear.row` / `period.month.row` | 月ピッカーの行 | 年全体 / 各月（同上） |
| `period.trend` / `period.trend.chart` / `period.trend.point` | 推移（自前 SVG・`TrendChart`） | 収支/支出=bar・純資産=line。年別=12ヶ月・全体=年集約。`point` は全体→年のドリルダウン |
| `cashflow.future.list` | CF 未来の入出金・振替予定 | ホーム未来日付入力が反映される一覧 |
| `cashflow.advanced.toggle` | CF 取り置き資金・資金目標の折りたたみ | 下部の補助情報を開閉 |
| `journal.view` | Journal ルート | 仕訳画面の検出 |
| `journal.entry.list` | Journal 一覧 | 仕訳一覧 |
| `journal.monthlyRecognition` | 今月の継続コスト認識カード | 読み取り専用（仕訳ではない月割り表示） |
| `journal.search` | Journal 検索入力 | 検索 |
| `journal.filter.clearAccount` | 科目絞り込み解除 | ドリルダウン解除 |
| `journal.entry.save` | Entry シート保存 | 保存 |
| `journal.entry.cancel` | Entry シートキャンセル | キャンセル |
| `journal.entry.delete` | Journal 行の削除 | 削除 |
| `journal.entry.reverse` | Journal 行の取消/返金 | 逆仕訳の起動 |
| `journal.entry.detailToggle` | 詳細（メモ・タグ）開閉 | 日常入力の詳細を折りたたみ表示 |
| `journal.entry.manualSwitch` | 詳細入力（借方/貸方）へ切替 | manual モードへ切替 |
| `journal.entry.allocateToggle` | 継続コスト化するトグル | 継続コストに切替（支出のみ） |
| `journal.entry.monthlyizeContinue` | 継続・買い替えトグル | ON で repeatEveryMonths=costMonths |
| `journal.entry.monthlyizeRepayToggle` | 分割/後日引落を資金繰りに入れる | 負債払いのみ表示 |
| `journal.entry.monthlyizeRepayAccount` / `...RepayCount` / `...RepayStart` | 引落口座/回数/初回引落日 | 返済 CF の生成（購入日と別） |
| `settings.expectedReturn` | 期待年利(%) | 資金目標の必要月額の参考計算 |
| `cashflow.schedule.flow.source` / `.destination` | 予定入力のお金の流れ | 源泉 → 行き先（入金/出金は自動判定） |
| `cashflow.goal.create` / `.list` / `.save` | 資金目標の追加/一覧/保存 | 長期の積立計画 |
| `cashflow.goal.name` / `.amount` / `.date` | 資金目標フォーム | 名称/目標額/期限 |
| `journal.entry.allocateMonths` | 継続する月数 | 継続する月数入力 |
| `journal.entry.date` | Entry 日付 | 日付入力 |
| `journal.entry.description` | Entry 摘要 | 摘要入力 |
| `journal.entry.item` | Entry 項目（摘要のユーザー向け名） | 日常入力の「項目」 |
| `journal.entry.flow` | お金の流れコンテナ | `源泉 → 行き先` |
| `journal.entry.flow.source` / `journal.entry.flow.destination` | 流れの左/右ピッカー | source=貸方 / destination=借方 |
| `journal.entry.debitAccount` | Entry 借方ピッカー（manual のみ） | 詳細入力（借方） |
| `journal.entry.creditAccount` | Entry 貸方ピッカー（manual のみ） | 詳細入力（貸方） |
| `journal.entry.amount` | Entry 金額 | 金額入力 |
| `journal.entry.memo` | Entry メモ | メモ入力 |
| `allocations.view` | 継続コスト ルート | 画面の検出（screen 名は歴史的に allocations） |
| `allocations.list` | 継続コストの一覧 | 継続コスト項目一覧 |
| `allocations.showCompleted` | 停止/終了表示トグル | 非 active の表示切替 |
| `allocations.edit.impactWarning` | 編集シートの過去再計算注意 | 総額/開始月/認識月数/周期/終了月/費用カテゴリ変更時に表示 |
| `adjustments.view` | 残高補正 ルート | 画面の検出 |
| `adjustments.list` | 登録済み補正の一覧 | 現実アンカーの一覧 |
| `adjustments.row.edit` / `adjustments.row.delete` | 一覧各行の編集 / 削除 | 補正の後編集・削除 |
| `adjustments.edit.save` | 補正編集シートの更新 | 編集保存（理論残高は自身を除外） |
| `adjustments.deleteConfirm` | 補正削除の確認ダイアログ | 削除確認 |
| `accounts.view` | Accounts ルート | 勘定科目の検出 |
| `accounts.create` | 科目追加ボタン | 追加起動 |
| `accounts.save` | 科目シート保存 | 保存 |
| `accounts.list` | 科目一覧 | 一覧 |
| `accounts.type` | 科目シートの区分セレクト | type 選択 |
| `accounts.role` | 科目シートの役割セレクト | role 選択 |
| `settings.view` | Settings ルート | 設定の検出 |
| `settings.manage.list` | 設定「管理」リスト | 補助画面への遷移リスト |
| `settings.manage.<screen>` | 管理リストの各行 | 例 `settings.manage.accounts`（accounts/tags/adjustments。各内訳ページはホームの各項目から） |
| `settings.exportJson` | export ボタン | JSON 書き出し |
| `settings.importJson` | import ボタン | JSON 読み込み起動 |
| `settings.importFile` | 隠しファイル入力 | ファイル選択 |
| `settings.resetAll` | 全削除ボタン | 全データ削除 |
| `nav.home` | ヘッダーホーム | Dashboard へ |
| `nav.menu.button` | ヘッダー `≡` | メニュー開閉 |
| `nav.menu` | ドロワー nav | メニュー本体 |
| `nav.<screen>` | メニュー各項目（管理・補助のみ） | `allocations`（継続コスト）/ `cashflow`（資金繰り）/ `settings` |
| `dialog.confirm` / `dialog.cancel` | ConfirmDialog | 確定 / キャンセル |
| `toast` | toast 領域 | 通知の検出 |

## 使用例

```ts
// Playwright（支出入力。科目はチップ=radio をラベルで選ぶ）
await page.locator('[data-ui="dashboard.entry.expense"]').click();
await page.locator('[data-ui="journal.entry.description"]').fill('ランチ');
await page.locator('[data-ui="journal.entry.debitAccount"]').getByText('食費', { exact: true }).click();
await page.locator('[data-ui="journal.entry.creditAccount"]').getByText('現金', { exact: true }).click();
await page.locator('[data-ui="journal.entry.amount"]').fill('2500');
await page.locator('[data-ui="journal.entry.save"]').click();
```

```ts
// Testing Library（ロール/ラベル優先）
await user.click(screen.getByRole('button', { name: '支出' }));
await user.type(screen.getByLabelText(/摘要/), 'ランチ');
await user.click(screen.getByRole('radio', { name: '食費' }));
```
