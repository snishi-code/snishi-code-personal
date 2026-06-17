# snishi-code-personal

[personal.snishi-code.com](https://personal.snishi-code.com) — 個人の生活向けに制作した
ウェブアプリ（PWA）を公開する個人カテゴリのサイトです。

> 入口サイトは [snishi-code.com](https://snishi-code.com)、医療向けは
> [medical.snishi-code.com](https://medical.snishi-code.com)（リポジトリ `snishi-code-medical`）です。

## アプリ

- `apps/simple-ledger` — 個人向けのローカル家計簿 PWA。仕訳・継続コスト・資金繰りを
  端末内のデータとして扱い、JSON export/import でバックアップできます。

## リポジトリ構成

- `apps/` — 公開アプリ本体。各アプリは独立した PWA として build されます。
- `packages/foundation/` — 外部送信ゼロ、PWA、QR、UI などの共通基盤。
- `index.html` / `shared.css` / `site-links.js` — カテゴリサイトのトップページ。
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

[Apache License 2.0](LICENSE) で公開しています。改変・再配布・商用利用は自由です。
著作権表示（[NOTICE](NOTICE)）は保持してください。

本ソフトウェアは「現状のまま（AS IS）」提供され、いかなる保証もありません。
利用にともなう責任は利用者が負うものとします。

商用利用や導入を行う場合は、可能であれば作者までご一報いただけると幸いです
（必須ではありません）。
