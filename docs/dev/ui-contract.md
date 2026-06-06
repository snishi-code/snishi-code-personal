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
| `dashboard.openPl` / `dashboard.openBs` | ホーム損益/資産負債サマリー | 財務諸表(PL/BS)へ遷移 |
| `journal.view` | Journal ルート | 仕訳画面の検出 |
| `journal.entry.list` | Journal 一覧 | 仕訳一覧 |
| `journal.search` | Journal 検索入力 | 検索 |
| `journal.filter.clearAccount` | 科目絞り込み解除 | ドリルダウン解除 |
| `journal.entry.save` | Entry シート保存 | 保存 |
| `journal.entry.cancel` | Entry シートキャンセル | キャンセル |
| `journal.entry.delete` | Journal 行の削除 | 削除 |
| `journal.entry.reverse` | Journal 行の取消/返金 | 逆仕訳の起動 |
| `journal.entry.detailToggle` | 詳細（メモ・タグ）開閉 | 日常入力の詳細を折りたたみ表示 |
| `journal.entry.manualSwitch` | 詳細入力（借方/貸方）へ切替 | manual モードへ切替 |
| `journal.entry.allocateToggle` | 按分するトグル | 按分支出に切替（支出のみ） |
| `journal.entry.allocateMonths` | 按分月数 | 按分月数入力 |
| `journal.entry.date` | Entry 日付 | 日付入力 |
| `journal.entry.description` | Entry 摘要 | 摘要入力 |
| `journal.entry.debitAccount` | Entry 借方役割のピッカー | 入金先/カテゴリ等（debit 側） |
| `journal.entry.creditAccount` | Entry 貸方役割のピッカー | カテゴリ/支払元/振替元等（credit 側） |
| `journal.entry.amount` | Entry 金額 | 金額入力 |
| `journal.entry.memo` | Entry メモ | メモ入力 |
| `statements.view` | Statements ルート | 財務諸表の検出 |
| `statements.profitAndLoss` | PL コンテナ | 損益計算書 |
| `statements.balanceSheet` | BS コンテナ | 貸借対照表 |
| `statements.tab.pl` / `statements.tab.bs` | セグメント | PL/BS 切替 |
| `statements.row` | 科目行 | Journal へドリルダウン |
| `allocations.view` | Allocations ルート | 按分台帳の検出 |
| `allocations.list` | 按分台帳の一覧 | 按分項目一覧 |
| `allocations.showCompleted` | 完了表示トグル | 完了分の表示切替 |
| `accounts.view` | Accounts ルート | 勘定科目の検出 |
| `accounts.create` | 科目追加ボタン | 追加起動 |
| `accounts.save` | 科目シート保存 | 保存 |
| `accounts.list` | 科目一覧 | 一覧 |
| `accounts.type` | 科目シートの区分セレクト | type 選択 |
| `accounts.role` | 科目シートの役割セレクト | role 選択 |
| `settings.view` | Settings ルート | 設定の検出 |
| `settings.manage.list` | 設定「管理」リスト | 補助画面への遷移リスト |
| `settings.manage.<screen>` | 管理リストの各行 | 例 `settings.manage.accounts`（accounts/tags/adjustments。財務諸表はホームから） |
| `settings.exportJson` | export ボタン | JSON 書き出し |
| `settings.importJson` | import ボタン | JSON 読み込み起動 |
| `settings.importFile` | 隠しファイル入力 | ファイル選択 |
| `settings.resetAll` | 全削除ボタン | 全データ削除 |
| `nav.home` | ヘッダーホーム | Dashboard へ |
| `nav.menu.button` | ヘッダー `≡` | メニュー開閉 |
| `nav.menu` | ドロワー nav | メニュー本体 |
| `nav.<screen>` | メニュー各項目（主要動線のみ） | `dashboard` / `journal` / `allocations` / `cashflow` / `settings` |
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
