# simple-ledger — Design system（tokens）

CSS variables による design tokens。正本は `simple-ledger/src/ui/tokens.css`。
色値はコンポーネントに直書きしない（`var(--*)` 参照のみ）。

> サイト全体の色の正本は各リポ `shared.css` の `:root`（`--bg` / `--surface` /
> `--text` / `--muted` / `--border` / teal 系）。本アプリの tokens はそれに整合させ、
> アプリ固有のトークン（状態色・フォーカス・スペーシング等）を追加している。

## 命名と用途（Figma variables/components へ移しやすい命名）

| トークン | 値 | 用途 |
|---|---|---|
| `--bg` | `#f8fafc` | ページ背景 |
| `--surface` | `#ffffff` | カード/シート/ヘッダー面 |
| `--text` | `#0f172a` | 本文 |
| `--muted` | `#64748b` | 補助テキスト |
| `--border` | `#e2e8f0` | 罫線/枠 |
| `--primary` | `#14b8a6`（teal-500） | ブランドのアクセント（フォーカス/枠/アイコン背景） |
| `--primary-fill` | `#0f766e`（teal-700） | **白文字の塗りボタン背景**（白で 4.9:1, WCAG AA） |
| `--primary-fill-strong` | `#115e59`（teal-800） | ボタン hover |
| `--primary-strong` | `#0f766e` | 強調テキスト/タグ文字（白地で十分なコントラスト） |
| `--primary-light` | `#f0fdfa`（teal-50） | 淡い背景（タグ/選択中） |
| `--primary-border` | `#5eead4`（teal-300） | 淡い枠 |
| `--on-primary` | `#ffffff` | primary 上の文字 |
| `--danger` | `#dc2626` | 破壊的操作/エラー |
| `--danger-light` / `--danger-border` | `#fef2f2` / `#fecaca` | エラー面/枠 |
| `--warning` | `#b45309`（amber-700） | 警告（白地でコントラスト確保） |
| `--warning-light` / `--warning-border` | `#fffbeb` / `#fde68a` | 警告面/枠 |
| `--success` | `#0f766e` | 成功（toast 背景 = 白文字 4.9:1） |
| `--pos` / `--neg` | `#0f766e` / `#dc2626` | 金額の増（teal-700）/減（赤）。記号 +/− も併記 |
| `--focus` / `--focus-ring` | `#14b8a6` / ring | フォーカス表示 |
| `--radius` / `--radius-sm` / `--radius-pill` | `12px` / `8px` / `999px` | 角丸 |
| `--shadow` / `--shadow-pop` | … | カード影 / ポップオーバー影 |
| `--space-1..6` | `4..32px` | スペーシングスケール |
| `--tap` | `44px` | 最小タップ領域 |
| `--maxw` / `--header-h` | `720px` / `56px` | レイアウト |
| `--font` | system stack | 書体 |

## コントラストの方針

- **teal-500（`--primary`）は白文字に対して 2.48:1 で不足**するため、白文字を載せる面
  （塗りボタン・アイコンボタン・成功 toast）には **teal-700（`--primary-fill` / `--success`）** を使う。
- teal-500 はアクセント（フォーカスリング、淡色背景の枠、テキストを載せないアイコン背景）に限定。
- 状態は色のみで伝えない（アイコン + 文言、金額は +/− 記号を併記）。

## React component 方針

- 文字列は i18n（`src/i18n`）、安定セレクタは UI contract（`src/ui-contract.ts`）。
- 汎用部品: `Icon`（Lucide パスのインライン）、`Field`（ラベル+control を id で結合）、
  `Modal` / `ConfirmDialog`、`toast`、`money`（金額表示）。
- 色・余白・角丸はトークン参照。マジックナンバーや色のハードコードを避ける。
- アイコンは **意味で参照**（`<Icon name="upload" />` 等）。新概念は既存トークンを再利用し、
  無ければ `Icon.tsx` に追加する（外部 CDN は読み込まない）。

## Figma への対応

- 上表の命名（`primary` / `surface` / `danger` / `space-*` / `radius-*`）はそのまま
  Figma variables のコレクション名に転用できる粒度。
- component 粒度（Button / Field / Modal / Toast / List item / Stat）も Figma component と 1:1 を意識。
