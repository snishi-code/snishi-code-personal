# simple-ledger — UI / UX

medical 側のコードは参照せず、snishi-code 系の抽象 UI 規約に従う。実装は
`simple-ledger-src/src/ui/`、文言は `src/i18n/ja.ts`。

## 全体方針

- スプレッドシート風 UI にしない。操作入口を少なくする。
- 主要操作は固定位置（ヘッダーの `+`）。補助操作はメニュー / 設定に集約。
- 白背景・控えめな線・teal を主色。角丸は控えめ（`--radius: 12px`）。
- タップ領域は **44px 以上**（`--tap: 44px`、`.icon-btn` / `.btn` / `.list__item` など）。
- **色だけに依存しない**: 状態はアイコン + 文言を併用（エラー=⚠+文、成功=✓+文、増減=記号 +/−）。
- 成功は toast。危険操作は明示確認。保存 / import / 削除は fail-closed。

## 画面構成（`src/ui/screens/`）

- **Dashboard**（初期表示）: 今月の収益 / 費用 / 純損益、資産 / 負債 / 純資産、最近の仕訳。
  仕訳が無ければ「最初の仕訳を追加」CTA。
- **Journal**: 仕訳一覧。検索（摘要・メモ）と期間絞り込み。行タップで編集、各行に削除。
- **Entry**（シート）: 日付・摘要・借方科目・貸方科目・金額・種別・メモ。MVP は 1 借方 1 貸方同額。
- **Statements**: PL / BS をセグメント切替。PL は期間（今月 / 今年 / 全期間）。
- **Accounts**: 勘定科目を区分ごとに残高つきで管理。追加 / 編集 / アーカイブ / 削除（参照中は不可）。
- **Settings**: JSON export / import、スナップショット、全データ削除、台帳設定、アプリ情報。
- **Help**: 使い方の説明（モーダル）。

## ヘッダー（`src/ui/Header.tsx`）

- 左: ホームアイコン（→ Dashboard）
- 中央: 台帳名 / `YYYY年MM月`
- 右: `+`（仕訳追加・最重要）/ `≡`（メニュー）

`+` は MVP 最重要操作なのでメニューに埋めず常時表示。

## メニュー（`src/ui/Menu.tsx`）

右からのドロワー: Dashboard / Journal / Statements / Accounts / Settings / Help。

## モーダル / シート規約（`src/ui/Modal.tsx`）

- 閉じるだけ / フォームは右上 `×` で閉じる。
- 保存 / キャンセルがあるフォームは下部に明確なボタン。
- import・全削除・復元など破壊的操作は **背景タップで閉じない**（`dismissable={false}`）。
- `Escape` はキャンセル相当。フォーカストラップ + 復帰、`role="dialog"` / `aria-modal`。
- 単一選択（メニュー項目など）は選んだら閉じる。

## toast（`src/ui/toast.tsx`）

- 成功 = success（teal）、失敗 = error（赤）。アイコン + 文言。`role="status"` / `aria-live="polite"`。
- **保存失敗時に成功 toast を出さない**（store の各アクションは失敗時 error toast + 例外送出）。

## 危険操作（`src/ui/ConfirmDialog.tsx`）

- 削除 / import 上書き / 復元は確認ダイアログ。確定ボタンは danger 色 + ⚠。
- 全データ削除は **キーワード入力一致**（「削除」と入力）まで確定を無効化。

## アクセシビリティ

- 主要操作は `getByRole` / `getByLabelText` で辿れるよう、ラベルと control を id で結ぶ。
- フォーム入力は 16px 以上（iOS のズーム回避）。
- コントラストは WCAG AA を満たす（teal-700 を白文字ボタン背景に使用）。
- スキップリンク、`:focus-visible` のフォーカスリング。
- E2E で axe-core の critical/serious 違反ゼロを検証（`e2e/a11y.spec.ts`）。

## 関連

- 安定セレクタ: [ui-contract.md](ui-contract.md)
- トークン: [design-system.md](design-system.md)
