/*
 * UI contract: テスト(Testing Library / Playwright)が依存してよい「安定名」の付与規約。
 *
 * 命名規約(ledger ui-contract 方式):
 *  - 第一選択はロール/アクセシブルネーム(getByRole / getByLabelText)。
 *    data-ui は日本語文言の変更で壊れない補助の安定名であり、見た目や
 *    DOM 構造・CSS クラスへの依存を避けるために使う。
 *  - 値はドット区切りの `領域.対象[.動作]`(例: 'journal.entry.save',
 *    'dialog.confirm', 'nav.menu.button')。
 *  - アプリは自分の名簿を `as const` オブジェクトで一元定義し、本関数で属性化する。
 *    名前をリテラルで散らさない(rename を 1 箇所で済ませるため)。
 */
export function uiAttr(name: string): { 'data-ui': string } {
  return { 'data-ui': name };
}
