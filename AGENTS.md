# AGENTS.md — このリポジトリの不変条件

このリポジトリ（同梱の `packages/foundation` を含む）を編集するときに、人間・AI を問わず
守る基本方針をまとめる。設計の詳細は `docs/` を参照。

## 不変条件（壊してはいけないもの）

- **外部送信ゼロ (no-exfil)**: ユーザー入力データは端末内のみで扱う。`fetch` /
  `XMLHttpRequest` / `WebSocket` / `EventSource` / `navigator.sendBeacon` による外部送信や、
  解析・トラッキング（GA / Sentry 等）は実装しない。例外は作らない。
- **local-first**: データは IndexedDB / localStorage 等の端末内ストレージを主体とする。
  バックアップや共有は JSON / QR の書き出しとユーザー自身の手段に限る。
- **fail-closed**: 保存・削除・移動などの破壊的操作は、失敗時に中断して明示通知する。
  catch で握りつぶして成功扱いのまま先へ進めない。可視状態を durable 状態より先に進めない
  （多段操作は atomic か補償付きにする）。
- **wire format の一元化**: QR 等のデータ交換フォーマットは正本モジュールを唯一の
  authority とし、別実装・重複定義を作らない。互換性を壊す変更をしない。
- **build output と source**: 配信成果物（`dist/` / `dist-site/`）は手で編集しない。
  source を直してビルドで再生成する。

## コミットしてはいけないもの

- 実在の患者データ・個人データ、施設固有の運用情報、秘密情報。
- 端末内データのエクスポート JSON。
- ローカル絶対パスやユーザー名などの環境固有情報。

## UI / アクセシビリティ

- UI 文言は i18n 経由で扱い、ハードコードしない。
- タップ領域は最小 44×44px。十字形・宗教シンボルのアイコンは使わない。

## 変更時の検証

コードを変更したら、コミット前に最低限以下を実行する。

```bash
npm run format:check
npm run lint
npm run no-exfil
npm test
```
