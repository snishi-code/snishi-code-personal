# snishi-code-personal

[personal.snishi-code.com](https://personal.snishi-code.com) — 個人の生活向けに制作した
ウェブアプリ（PWA）を公開する個人カテゴリのサイトです。

> 入口サイトは [snishi-code.com](https://snishi-code.com)、医療向けは
> [medical.snishi-code.com](https://medical.snishi-code.com)（リポジトリ `snishi-code-medical`）です。

## アプリ

- `apps/simple-ledger` — 個人利用向けのローカル家計簿 PWA。仕訳・継続コスト・資金繰りを
  端末内（IndexedDB / localStorage）のデータとして扱い、外部送信は行いません。
  バックアップや端末移行は JSON export/import で行います。
- `apps/template-memo` — 決まった型で繰り返し書くメモのための PWA。場所を定める「フレーム」と
  入力項目を定める「フォーマット」を独立部品として作り、その組み合わせを「テンプレート」として使います。
  完成文は QR で取り出せます。部品の受け渡し（QR）とバックアップ（JSON export/import）は
  いずれも外部送信を伴いません。完成文章の例からテンプレート一式を作る補助では、アプリはAIへ接続せず、
  依頼文の表示と返答JSONの検証だけを行います。外部AIへ渡す場合は利用者が内容を確認してコピーします。

個人利用を想定したプロジェクトとして公開しています。

## リポジトリ構成

- `apps/simple-ledger/` — 公開アプリ本体。独立した PWA として build されます。
- `apps/template-memo/` — 公開アプリ本体。独立した PWA として build されます。
- `packages/foundation/` — 外部送信ゼロ、PWA、QR、UI などの共通基盤。
- `site/` — カテゴリトップと各アプリの紹介ページ（静的サイト素材）。
- `docs/` — 設計ドキュメント。
- `tools/` — `no-exfil-guard.sh` などの開発・検証スクリプト。
- `build.sh` — Cloudflare Pages 向けに `dist-site/` を生成する build スクリプト。

## 開発

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run no-exfil
SKIP_NPM_CI=1 bash build.sh
```

`build.sh` はカテゴリトップと各アプリの build 結果を `dist-site/` にまとめます。
Cloudflare Pages の build output は `dist-site` です。

## 設計の考え方

- **データは端末内のみ** — 入力データは利用者の端末内だけに保存し、外部送信しません。
- **オフライン動作** — ネット接続がなくても使えるよう設計しています。
- 解析・トラッキングのライブラリは入れていません。

## ライセンス

- 本リポジトリのコードは [Apache License 2.0](LICENSE) で公開しています。改変・再配布・
  商用利用は自由です。著作権表示（[NOTICE](NOTICE)）は保持してください。
- 同梱している第三者コードのライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
  を参照してください。

本ソフトウェアは「現状のまま（AS IS）」提供され、いかなる保証もありません。
利用にともなう責任は利用者が負うものとします。

商用利用や導入を行う場合は、可能であれば作者までご一報いただけると幸いです
（必須ではありません）。
