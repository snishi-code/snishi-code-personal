/*
 * テンプレート QR の wire authority。
 *
 * 対象・グループ・設定などを誤って載せないため、送信前に normalizeTemplate() で
 * Template の既知フィールドだけへ射影する。wire JSON は
 *   { v: 2, template: Template }
 * のみ。transport は C1 (deflate-raw・非暗号) を必須とし、foundation の
 * protocol/crypto を唯一の transport authority として使う。
 */

import {
  assemblePages,
  decodePage,
  encodePages,
  HEADER_BUDGET,
  MAX_BYTES,
  type DecodedPage,
} from '@snishi/foundation/qr/protocol';
import { packPayload, unpackPayload } from '@snishi/foundation/qr/crypto';
import { normalizeTemplate, type Template } from './template';

export const TEMPLATE_WIRE_KIND = 'TPL' as const;
const TEMPLATE_WIRE_VERSION = 2 as const;

export type TemplateWireErrorCode =
  | 'invalid-template'
  | 'compression-required'
  | 'empty-pages'
  | 'invalid-page'
  | 'wrong-kind'
  | 'mixed-batch'
  | 'incomplete-pages'
  | 'invalid-transport'
  | 'invalid-json'
  | 'wrong-version';

/** UI が i18n 文言へ写像できる、安定したエラーコード付き例外。 */
export class TemplateWireError extends Error {
  readonly code: TemplateWireErrorCode;

  constructor(code: TemplateWireErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'TemplateWireError';
    this.code = code;
  }
}

interface EncodeTemplateWireOptions {
  /** 決定論テスト用。通常は protocol.newBatchId() に任せる。 */
  batchId?: string;
  /** 通常は protocol.MAX_BYTES。小さい値はページングの決定論テスト用。 */
  maxBytes?: number;
}

interface TemplateWireEnvelope {
  v: typeof TEMPLATE_WIRE_VERSION;
  template: Template;
}

function fail(code: TemplateWireErrorCode, cause?: unknown): never {
  throw new TemplateWireError(code, cause === undefined ? undefined : { cause });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Template だけを C1 圧縮し、TPL ページ列へする。
 *
 * packPayload は CompressionStream 非対応時や圧縮で短くならない時に平文へ
 * fallback するが、この wire は C1 必須なので、その場合は QR を出さず fail-closed。
 */
export async function encodeTemplateWirePages(
  template: Template,
  options: EncodeTemplateWireOptions = {},
): Promise<string[]> {
  const normalized = normalizeTemplate(template);
  if (!normalized) fail('invalid-template');

  const envelope: TemplateWireEnvelope = {
    v: TEMPLATE_WIRE_VERSION,
    template: normalized,
  };

  let payload: string;
  try {
    payload = await packPayload(JSON.stringify(envelope), { compress: true });
  } catch (error) {
    fail('compression-required', error);
  }
  if (!payload.startsWith('C1:')) fail('compression-required');

  const maxBytes = options.maxBytes ?? MAX_BYTES;
  // protocol の chunk budget が正になることを呼び出し側で保証する。
  if (!Number.isFinite(maxBytes) || maxBytes <= HEADER_BUDGET) fail('invalid-page');

  const pages = encodePages({
    kind: TEMPLATE_WIRE_KIND,
    payload,
    batchId: options.batchId,
    maxBytes,
  });
  if (pages.length === 0) fail('empty-pages');
  return pages;
}

function decodeAndValidatePages(pageTexts: readonly string[]): DecodedPage[] {
  if (!Array.isArray(pageTexts) || pageTexts.length === 0) fail('empty-pages');

  const decoded: DecodedPage[] = [];
  let batchId: string | null = null;
  let totalPages: number | null = null;
  const seen = new Map<number, string>();

  for (const text of pageTexts) {
    const page = decodePage(text);
    if (!page) fail('invalid-page');
    if (page.kind !== TEMPLATE_WIRE_KIND) fail('wrong-kind');
    if (
      !Number.isSafeInteger(page.pageNum) ||
      !Number.isSafeInteger(page.totalPages) ||
      page.totalPages < 1 ||
      page.pageNum < 1 ||
      page.pageNum > page.totalPages
    ) {
      fail('invalid-page');
    }

    if (batchId === null) batchId = page.batchId;
    else if (batchId !== page.batchId) fail('mixed-batch');

    if (totalPages === null) totalPages = page.totalPages;
    else if (totalPages !== page.totalPages) fail('mixed-batch');

    const prior = seen.get(page.pageNum);
    // 同じページの同内容再読取は許容。内容が違う重複は曖昧なので拒否する。
    if (prior !== undefined && prior !== page.content) fail('mixed-batch');
    if (prior === undefined) {
      seen.set(page.pageNum, page.content);
      decoded.push(page);
    }
  }

  if (totalPages === null || seen.size !== totalPages) fail('incomplete-pages');
  return decoded;
}

async function decodeTransportPayload(payload: string): Promise<Template> {
  // この wire は C1 のみ。plain/E1/E2 を透過的に受けると仕様外データを
  // テンプレートとして適用してしまうため、unpack 前に prefix を照合する。
  if (!payload.startsWith('C1:')) fail('invalid-transport');

  let plain: string;
  try {
    plain = await unpackPayload(payload);
  } catch (error) {
    fail('invalid-transport', error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch (error) {
    fail('invalid-json', error);
  }
  if (!isPlainObject(parsed)) fail('invalid-json');
  if (parsed.v !== TEMPLATE_WIRE_VERSION) fail('wrong-version');

  const template = normalizeTemplate(parsed.template);
  if (!template) fail('invalid-template');
  return template;
}

/**
 * 順不同・同内容重複を許容して全ページを復元し、C1→JSON→Template を検証する。
 * 欠落・バッチ混在・kind 違い・解凍/JSON/normalize 失敗はすべて throw。
 */
export async function decodeTemplateWirePages(pageTexts: readonly string[]): Promise<Template> {
  const decoded = decodeAndValidatePages(pageTexts);
  const payload = assemblePages(decoded);
  if (payload === null) fail('incomplete-pages');
  return decodeTransportPayload(payload);
}

export type TemplateWireReceiveResult =
  | {
      status: 'rejected';
      consumed: false;
      reason: 'invalid-page' | 'wrong-kind';
      got: number;
      total: number;
      gotKind?: string;
    }
  | {
      status: 'duplicate' | 'progress';
      consumed: true;
      got: number;
      total: number;
      newBatch: boolean;
    }
  | {
      status: 'complete';
      consumed: true;
      got: number;
      total: number;
      newBatch: boolean;
      template: Template;
    };

interface TemplateWireCollector {
  receivePage(text: string): Promise<TemplateWireReceiveResult>;
  reset(): void;
  progress(): { got: number; total: number };
}

/**
 * カメラ/貼り付け兼用の増分受信バッファ。
 *
 * 形式・kind 不一致は consumed:false で現在のバッファを維持する。正常な別 batch の
 * 先頭が来た時だけ古い断片を破棄する。全ページの decode に失敗した場合もバッファを
 * 維持し、UI がエラーと入力を残したまま明示的に reset できるようにする。
 */
export function createTemplateWireCollector(): TemplateWireCollector {
  let batchId: string | null = null;
  let total = 0;
  const pages = new Map<number, string>();

  const reset = () => {
    batchId = null;
    total = 0;
    pages.clear();
  };

  return {
    reset,
    progress: () => ({ got: pages.size, total }),
    async receivePage(text) {
      const page = decodePage(text);
      if (!page) {
        return {
          status: 'rejected',
          consumed: false,
          reason: 'invalid-page',
          got: pages.size,
          total,
        };
      }
      if (page.kind !== TEMPLATE_WIRE_KIND) {
        return {
          status: 'rejected',
          consumed: false,
          reason: 'wrong-kind',
          gotKind: page.kind,
          got: pages.size,
          total,
        };
      }
      if (
        !Number.isSafeInteger(page.pageNum) ||
        !Number.isSafeInteger(page.totalPages) ||
        page.totalPages < 1 ||
        page.pageNum < 1 ||
        page.pageNum > page.totalPages
      ) {
        return {
          status: 'rejected',
          consumed: false,
          reason: 'invalid-page',
          got: pages.size,
          total,
        };
      }

      let newBatch = false;
      if (batchId !== null && batchId !== page.batchId) {
        reset();
        newBatch = true;
      }
      if (batchId === null) {
        batchId = page.batchId;
        total = page.totalPages;
      } else if (total !== page.totalPages) {
        return {
          status: 'rejected',
          consumed: false,
          reason: 'invalid-page',
          got: pages.size,
          total,
        };
      }

      const prior = pages.get(page.pageNum);
      if (prior !== undefined && prior !== page.content) {
        return {
          status: 'rejected',
          consumed: false,
          reason: 'invalid-page',
          got: pages.size,
          total,
        };
      }
      if (prior !== undefined) {
        return {
          status: 'duplicate',
          consumed: true,
          got: pages.size,
          total,
          newBatch,
        };
      }

      pages.set(page.pageNum, page.content);
      if (pages.size < total) {
        return {
          status: 'progress',
          consumed: true,
          got: pages.size,
          total,
          newBatch,
        };
      }

      const pageTexts: string[] = [];
      for (let n = 1; n <= total; n += 1) {
        const content = pages.get(n);
        if (content === undefined) fail('incomplete-pages');
        pageTexts.push(`RND_${TEMPLATE_WIRE_KIND} #${batchId} ${n}/${total}\n${content}`);
      }
      const template = await decodeTemplateWirePages(pageTexts);
      const completedTotal = total;
      reset();
      return {
        status: 'complete',
        consumed: true,
        got: completedTotal,
        total: completedTotal,
        newBatch,
        template,
      };
    },
  };
}

/** 受信確認画面に出す件数（表示ロジックと数え方を一箇所にする）。 */
export function summarizeTemplate(template: Template): {
  sections: number;
  formats: number;
  items: number;
} {
  let formats = 0;
  let items = 0;
  for (const section of template.sections) {
    formats += section.formats.length;
    for (const format of section.formats) items += format.items.length;
  }
  return { sections: template.sections.length, formats, items };
}
