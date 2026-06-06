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
| `dashboard.entry.create` | Dashboard 空状態 CTA | 最初の仕訳追加 |
| `dashboard.recent.list` | Dashboard 最近の仕訳 | 一覧 |
| `journal.view` | Journal ルート | 仕訳画面の検出 |
| `journal.entry.create` | ヘッダー `+` ボタン | 仕訳追加の起動（最重要操作） |
| `journal.entry.list` | Journal 一覧 | 仕訳一覧 |
| `journal.search` | Journal 検索入力 | 検索 |
| `journal.entry.save` | Entry シート保存 | 保存 |
| `journal.entry.cancel` | Entry シートキャンセル | キャンセル |
| `journal.entry.delete` | Journal 行の削除 | 削除 |
| `journal.entry.date` | Entry 日付 | 日付入力 |
| `journal.entry.description` | Entry 摘要 | 摘要入力 |
| `journal.entry.debitAccount` | Entry 借方 | 借方科目選択 |
| `journal.entry.creditAccount` | Entry 貸方 | 貸方科目選択 |
| `journal.entry.amount` | Entry 金額 | 金額入力 |
| `journal.entry.memo` | Entry メモ | メモ入力 |
| `statements.view` | Statements ルート | 財務諸表の検出 |
| `statements.profitAndLoss` | PL コンテナ | 損益計算書 |
| `statements.balanceSheet` | BS コンテナ | 貸借対照表 |
| `statements.tab.pl` / `statements.tab.bs` | セグメント | PL/BS 切替 |
| `accounts.view` | Accounts ルート | 勘定科目の検出 |
| `accounts.create` | 科目追加ボタン | 追加起動 |
| `accounts.save` | 科目シート保存 | 保存 |
| `accounts.list` | 科目一覧 | 一覧 |
| `settings.view` | Settings ルート | 設定の検出 |
| `settings.exportJson` | export ボタン | JSON 書き出し |
| `settings.importJson` | import ボタン | JSON 読み込み起動 |
| `settings.importFile` | 隠しファイル入力 | ファイル選択 |
| `settings.resetAll` | 全削除ボタン | 全データ削除 |
| `nav.home` | ヘッダーホーム | Dashboard へ |
| `nav.menu.button` | ヘッダー `≡` | メニュー開閉 |
| `nav.menu` | ドロワー nav | メニュー本体 |
| `nav.<screen>` | メニュー各項目 | 例 `nav.journal`（`navigation.ts` の screen 名） |
| `dialog.confirm` / `dialog.cancel` | ConfirmDialog | 確定 / キャンセル |
| `toast` | toast 領域 | 通知の検出 |

## 使用例

```ts
// Playwright
await page.locator('[data-ui="journal.entry.create"]').first().click();
await page.locator('[data-ui="journal.entry.amount"]').fill('2500');
await page.locator('[data-ui="journal.entry.save"]').click();
```

```ts
// Testing Library（ロール/ラベル優先）
await user.click(screen.getByRole('button', { name: '仕訳を追加' }));
await user.type(screen.getByLabelText(/摘要/), 'ランチ');
```
