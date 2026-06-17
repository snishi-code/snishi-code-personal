// 移植元: simple-ledger src/data/exportImport.ts の型定義の汎用化

/** JSON 交換ファイルの封筒。アプリ固有のペイロードはこの封筒の外側に並べて追加する。 */
export interface ExchangeEnvelope {
  appId: string;
  schemaVersion: number;
  exportedAt: string;
  /** export 元が基準とした revision(楽観的衝突検出用。使わないアプリは省略可)。 */
  revision?: number;
}

// fail-closed import の結果。エラー系は必ず detail を持ち、UI がそのまま提示できる。
export type ImportOutcome<TPkg> =
  | { kind: 'ok'; pkg: TPkg }
  | { kind: 'parse-error'; detail: string }
  | { kind: 'not-our-file'; detail: string }
  | { kind: 'unsupported-version'; detail: string }
  | { kind: 'validation-error'; detail: string }
  | {
      kind: 'revision-conflict';
      detail: string;
      localRevision: number;
      importRevision: number;
    }
  | { kind: 'storage-error'; detail: string };
