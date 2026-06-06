# simple-ledger（ソース）

家計簿アプリ（複式簿記・ローカルファースト・外部送信ゼロ・PWA）の **ソース** です。

## 配信の仕組み（重要）

このサイトは「リポジトリのファイルをそのまま静的配信（ビルドなし）」で動いています。
そのため **ビルド成果物を配信パスへ出力してコミット** します。

- ソース: `simple-ledger-src/`（このフォルダ）
- 配信実体: リポジトリ直下 **`simple-ledger/`**（`npm run build` が生成。git 管理・配信される）
  - `index.html` + `assets/`（バンドル）+ `sw.js` + `manifest.json` + `icons/`
- 公開 URL: `https://personal(-dev).snishi-code.com/simple-ledger/`

> ⚠️ `simple-ledger/`（生成物）を直接編集しないこと。必ずソースを直して
> `npm run build` → `../simple-ledger/` を再生成 → コミットする。
> **ソースだけ更新してビルドを忘れると本番が真っ白になる**（生成物が更新されないため）。

## 開発

```sh
cd simple-ledger-src
npm install
npm run dev            # ローカル開発（http://localhost:5173/simple-ledger/）
npm run typecheck
npm run lint
npm run format:check
npm test               # Vitest（単体・UI）
npm run test:e2e       # Playwright（本番ビルドを preview して検証）
npm run build          # ../simple-ledger/ に配信成果物を出力（コミット対象）
```

## ドキュメント

- 会計モデル: `../docs/dev/ledger-concept.md`
- UI/UX: `../docs/dev/ledger-ui-ux.md`
- データ形式 / import / migration: `../docs/dev/ledger-protocol.md`
- テスト安定名（UI contract）: `../docs/dev/ui-contract.md`
- デザイントークン: `../docs/dev/design-system.md`
- 設計判断（ADR）: `../docs/adr/0001-local-first-ledger.md`
