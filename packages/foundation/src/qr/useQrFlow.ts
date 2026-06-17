// 移植元: snishi-code-medical/hospital-rounds/src/features/qr-flow.js
// (createQrFlow のライフサイクルを DOM 配線なしの React hook に。描画は render.ts、
//  カメラは scan.ts、文言生成はアプリ側に分離し、ここはフロー制御だけを持つ)
import { useCallback, useEffect, useRef, useState } from 'react';
import { encodePages, decodePage, newBatchId } from './protocol.js';
import { packPayload, unpackPayload } from './crypto.js';

export interface QrFlowConfig<TDecoded> {
  kind: string;
  // foundation は文言を出さない。アプリ側が status 表示 (wrongKind 警告等) に使う表示名
  kindLabel: string;
  encodePayload(): string;
  // throw = fail-closed (壊れた payload を onApply に到達させない)
  decodePayload(plain: string): TDecoded;
  shouldEncrypt(): boolean;
  compress?: boolean;
  maxBytes?: number;
  // 鍵は foundation に埋め込まず常に注入する。現行アプリとの QR 互換は、アプリ側が
  // v1 と同一の鍵を渡すことで成立する (foundation に鍵を置くと全アプリが同一鍵を
  // 共有してしまい、アプリ毎の鍵分離・差し替えができなくなるため)。
  keyBytes: Uint8Array;
  onApply(decoded: TDecoded, ctrl: { close(): void }): void | Promise<void>;
}

// v1 ingestPage の状態遷移をそのままコード化 (文言はアプリ側で status から生成)
export type ReceiveStatus = 'unknownFormat' | 'wrongKind' | 'duplicate' | 'progress' | 'complete';

export interface ReceiveResult {
  done: boolean;
  // consumed=false (形式不一致・kind 違い) は「入力欄を消してはいけない」の合図 (v1 準拠)
  consumed: boolean;
  status: ReceiveStatus;
  // 受信途中に別 batchId が来て古い断片を破棄した (v1 の newBatch リセット)
  newBatch: boolean;
  got: number;
  total: number;
  // wrongKind の時に実際に読めた kind (アプリの警告文言用)
  gotKind?: string;
}

export interface QrRecvState {
  batchId: string | null;
  total: number;
  got: number;
}

export interface QrFlow {
  open(): Promise<void>;
  close(): void;
  refresh(): Promise<void>;
  isActive: boolean;
  pages: string[];
  pageIndex: number;
  next(): void;
  prev(): void;
  receivePage(text: string): Promise<ReceiveResult>;
  recv: QrRecvState;
}

interface RecvBuffer {
  batchId: string | null;
  total: number;
  pages: Map<number, string>; // pageNum → content (順不同受信を許容)
}

export function useQrFlow<TDecoded>(cfg: QrFlowConfig<TDecoded>): QrFlow {
  const [pages, setPages] = useState<string[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [isActive, setIsActive] = useState(false);
  const [recv, setRecv] = useState<QrRecvState>({ batchId: null, total: 0, got: 0 });

  // 最新 cfg は ref で参照する (callback を安定させつつ stale closure を避ける)。
  // render 中の ref 書込は禁止のため effect で同期する (receivePage 等の呼び出しは
  // イベントハンドラ経由 = effect 後なので常に最新 cfg が見える)
  const cfgRef = useRef(cfg);
  useEffect(() => {
    cfgRef.current = cfg;
  });
  const pagesRef = useRef<string[]>(pages);
  const isActiveRef = useRef(isActive);
  const recvRef = useRef<RecvBuffer>({ batchId: null, total: 0, pages: new Map() });

  const applyPages = useCallback((next: string[]) => {
    pagesRef.current = next;
    setPages(next);
    setPageIndex(0);
  }, []);

  const syncRecv = useCallback(() => {
    const buf = recvRef.current;
    setRecv({ batchId: buf.batchId, total: buf.total, got: buf.pages.size });
  }, []);

  const regenerate = useCallback(async (): Promise<void> => {
    const c = cfgRef.current;
    let payload = c.encodePayload();
    if (payload) {
      try {
        payload = await packPayload(payload, {
          encrypt: c.shouldEncrypt(),
          compress: !!c.compress,
          keyBytes: c.keyBytes,
        });
      } catch (e) {
        // 暗号化が要るのに失敗した時は安全側に倒し QR を出さない (v1 と同じ fail-closed)。
        // v1 は console.error で握ったが、hook は呼び出し側へ伝播して通知判断を委ねる
        applyPages([]);
        throw e;
      }
    }
    applyPages(
      payload
        ? encodePages({ kind: c.kind, payload, batchId: newBatchId(), maxBytes: c.maxBytes })
        : [],
    );
  }, [applyPages]);

  const open = useCallback(async (): Promise<void> => {
    isActiveRef.current = true;
    setIsActive(true);
    await regenerate();
  }, [regenerate]);

  const close = useCallback((): void => {
    isActiveRef.current = false;
    setIsActive(false);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!isActiveRef.current) return; // v1 同様、表示中だけ再生成
    await regenerate();
  }, [regenerate]);

  const next = useCallback((): void => {
    setPageIndex((i) => Math.min(i + 1, Math.max(0, pagesRef.current.length - 1)));
  }, []);

  const prev = useCallback((): void => {
    setPageIndex((i) => Math.max(0, i - 1));
  }, []);

  // 1 ページ分の生 QR テキストを取り込む (v1 ingestPage + applyPayload 準拠):
  //   - 形式不正 / kind 違いは consumed:false で拒否 (入力を残す)
  //   - batchId 変化 = 新しい送信。古い断片と混ぜず状態をリセットして新バッチ開始
  //   - 重複ページは進捗を進めず無害
  //   - 順不同受信を許容 (Map に pageNum で保持)
  //   - 全ページ揃った時点で受信状態を破棄し (v1 resetRecv と同位置)、
  //     unpack → decodePayload → onApply。復号失敗・パース失敗は throw して
  //     onApply に到達させない (fail-closed。通知はアプリ側が catch して出す)
  const receivePage = useCallback(
    async (text: string): Promise<ReceiveResult> => {
      const c = cfgRef.current;
      const buf = recvRef.current;
      const base = { done: false as const, newBatch: false };

      const decoded = decodePage(text);
      if (!decoded) {
        return {
          ...base,
          consumed: false,
          status: 'unknownFormat',
          got: buf.pages.size,
          total: buf.total,
        };
      }
      if (decoded.kind !== c.kind) {
        return {
          ...base,
          consumed: false,
          status: 'wrongKind',
          gotKind: decoded.kind,
          got: buf.pages.size,
          total: buf.total,
        };
      }

      let newBatch = false;
      if (buf.batchId && buf.batchId !== decoded.batchId) {
        buf.batchId = null;
        buf.total = 0;
        buf.pages.clear();
        newBatch = true;
      }
      if (!buf.batchId) {
        buf.batchId = decoded.batchId;
        buf.total = decoded.totalPages;
      }
      // v1 に無いガード: 範囲外 pageNum を数えると got==total なのに歯抜け、という
      // 組み立て不能状態に陥るため、ヘッダ矛盾 (N > M 等) として拒否する (fail-closed)
      if (decoded.pageNum < 1 || decoded.pageNum > buf.total) {
        syncRecv();
        return {
          done: false,
          consumed: false,
          newBatch,
          status: 'unknownFormat',
          got: buf.pages.size,
          total: buf.total,
        };
      }
      if (buf.pages.has(decoded.pageNum)) {
        syncRecv();
        return {
          done: false,
          consumed: true,
          newBatch,
          status: 'duplicate',
          got: buf.pages.size,
          total: buf.total,
        };
      }
      buf.pages.set(decoded.pageNum, decoded.content);
      if (buf.pages.size < buf.total) {
        syncRecv();
        return {
          done: false,
          consumed: true,
          newBatch,
          status: 'progress',
          got: buf.pages.size,
          total: buf.total,
        };
      }

      // 全ページ揃った。encodePages は境界 \n を content 側に保持するので "" 連結で復元
      const total = buf.total;
      const fullParts: string[] = [];
      for (let i = 1; i <= total; i++) fullParts.push(buf.pages.get(i) ?? '');
      const payload = fullParts.join('');
      // v1 と同位置で受信状態を破棄 (以降の失敗は新たな読み直しから再開する)
      buf.batchId = null;
      buf.total = 0;
      buf.pages.clear();
      syncRecv();

      const plain = await unpackPayload(payload, { keyBytes: c.keyBytes });
      const decodedPayload = c.decodePayload(plain);
      await c.onApply(decodedPayload, { close });
      return { done: true, consumed: true, newBatch, status: 'complete', got: total, total };
    },
    [close, syncRecv],
  );

  return { open, close, refresh, isActive, pages, pageIndex, next, prev, receivePage, recv };
}
