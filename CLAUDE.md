# CLAUDE.md — snishi-code-personal（個人カテゴリ）

<!-- ===== サイト憲法（全リポ共通）ここから =====
  正本は apex リポ（snishi-code.com）。3リポに同一コピー。
  変更は apex で直し medical / personal へ反映する
  （別 origin のため物理コピーが必要。site-links.js と同じ運用）。 -->

## サイト憲法（全リポ共通・正本=apex）

### origin 分離
アプリは別サブドメイン（= 別 origin）に分離。各リポは自分のカテゴリだけを管理する。

| origin | repo | 内容 |
|---|---|---|
| `snishi-code.com`（apex） | `snishi-code.com` | カテゴリ入口（静的のみ） |
| `medical(-dev).snishi-code.com` | `snishi-code-medical` | 医療アプリ（回診ほか） |
| `personal(-dev).snishi-code.com` | `snishi-code-personal` | 個人アプリ |

main=本番 / dev=テスト。env はホスト名規約で判定（`-dev.` / `*.pages.dev` / `localhost` を test、他を prod）。特定ドメインを直書きしない。

### 外部送信ゼロ（絶対・例外なし）
ユーザー入力データは端末内のみ。`fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `navigator.sendBeacon` での外部送信は実装しない。GA / Sentry 等のトラッキングも入れない。**personal を含む全カテゴリで例外なし**（「送信可」の例外文を作らない＝例外文の存在自体が CLAUDE.md / メモリ経由の漏洩源になる）。
- **機械ガードで担保**: `tools/no-exfil-guard.sh` が pre-commit（`git config core.hooksPath .githooks`）と GitHub Action（`.github/workflows/no-exfil.yml`）の両方で走る。正規の同一オリジン通信（service worker のキャッシュ等）のみ該当行に `// network-ok: <理由>` を付けて承認する。
- **オフライン動作前提**。外部 CDN 読み込み禁止（ライブラリはバンドルに含め、ライセンス表記をファイル先頭に残す）。

### サイト横断リンク
apex ↔ medical ↔ personal の絶対 URL は `site-links.js` の1箇所で管理（**正本=apex**、各リポにコピー）。HTML は href を直書きせず `data-link="personal"` 等の属性で参照する。

### カラー / デザイン（共通）
- カラー変数は各リポ `shared.css` の `:root` が正本（`--blue` / `--green`（実値 teal） / `--neutral` + `-light` / `-border`）。ハードコード禁止。背景 `--bg: #f8fafc`、サーフェスは白。
- カテゴリ色: **apex=neutral `#475569` / 医療=blue `#2563eb` / 個人=teal `#14b8a6`**。**入口（apex）では青・緑を使わない**（neutral）。ビビッド系（黄・赤）・癖の強い紫は共通色に採用しない。
- カテゴリ代表アイコン: 医療=心電図波形、個人=芽（sprout）。サイトロゴ=`</>`。**十字・宗教的シンボルは避ける**。
- UIアイコンは Lucide。概念→グリフの正本は `shared/icons.js`（apex）で各アプリへコピー。**意味で参照**（`icon("share")` 等）し、新概念は既存トークン再利用／無ければ追加。固有ブランドロゴは別途ベクター（Lucide に無いものは手描き起こしに頼らない）。

### ドキュメント原則
**正本が別にあるものは CLAUDE.md にコピーせずポインタにする**（例: 色値=`shared.css :root`、アプリ固有のリファレンスは `docs/dev/`）。CLAUDE.md は「毎回必要な不変条件」だけに保つ。

<!-- ===== サイト憲法 ここまで ===== -->

---

## このリポジトリ固有（personal = 個人カテゴリ）

- 個人向けのシンプルなウェブアプリを開発・配信する。**現状、配信中のアプリはまだ無い**（`index.html` は入口 + 「準備中」カードのみ）。
- **teal 系で統一**。`badge-green` / `cat-card-green` / `app-icon-green` 等のクラスを使う（クラス名は歴史的経緯で `green` だが、実値は teal）。
- 個別アプリのアイコンは**カテゴリ色 + 固有の形**（カテゴリ色だけの汎用アイコンは禁止）。
- **同期は「アプリ内で外部送信」ではなく、JSON 書き出し + Obsidian sync 等のアプリ外手段で実現する**。これにより個人アプリも「外部送信ゼロ」を維持できる（憲法どおり）。送信ありの機能が本当に必要になったら、サイトの約束を濁さないよう別途設計を相談すること。
