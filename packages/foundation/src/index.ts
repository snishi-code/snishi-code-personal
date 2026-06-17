// @snishi/foundation — 公開エントリ。
// 監査しやすさのため、再エクスポートの集約はせずサブパス import を正とする
// (どのモジュールに依存しているかが import 文だけで追えるように)。
//
// モジュールマップ:
//   storage/idb        createDatabase — IndexedDB ラッパ(runtime truth)
//   storage/pointers   createPointerStore — localStorage は短い同期ポインタのみ
//   snapshot/snapshots createSnapshotStore — 破壊操作前バックアップ + 復元undo + PII purge
//   exchange/*         createImportPipeline / createMigrationChain — fail-closed import/export
//   qr/protocol        750B ページ分割・multi-page ヘッダ(Wire Format Authority)
//   qr/crypto          packPayload/unpackPayload — E1/E2/C1/plain(鍵はアプリ注入)
//   qr/render, qr/scan, qr/useQrFlow, qr/receiverRegistry
//   ui/*               tokens.css / foundation.css / Modal(native <dialog>) / Button / Field /
//                      toast / useDirtyGuard / AppHeader / Icon / contract(data-ui)
//   history/*          createAppHistory / useAppHistory — 戻る優先順位制御 + exit guard
//   i18n/createI18n    型安全 key→文言
//   eventlog/*         createEventLog — PII ゼロ前提の端末内イベントログ
//   pwa/*              凍結 SW テンプレート / 登録のみの useServiceWorker / getEnv
export const FOUNDATION_VERSION = '0.1.0';
