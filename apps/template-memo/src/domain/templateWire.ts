/*
 * フレーム・フォーマット・テンプレートパッケージ QR の wire authority。
 *
 * transport はすべて C1（deflate-raw・非暗号）。対象・グループ・入力値を型として
 * 受け取らず、各 normalize 関数で既知フィールドだけへ射影してから送信する。
 */

import {
  assemblePages,
  decodePage,
  encodePages,
  HEADER_BUDGET,
  MAX_BYTES,
  uniqueName,
  type DecodedPage,
} from '@snishi/foundation/qr/protocol';
import { packPayload, unpackPayload } from '@snishi/foundation/qr/crypto';
import { newId } from '../data/constants';
import {
  normalizeFormat,
  normalizeFrame,
  normalizeTemplateDef,
  type Format,
  type Frame,
  type TemplateDef,
} from './entities';

export const TEMPLATE_WIRE_KIND = 'TPL' as const;
export const FRAME_WIRE_KIND = 'FRM' as const;
export const FORMAT_WIRE_KIND = 'FMT' as const;
export type ShareWireKind =
  | typeof TEMPLATE_WIRE_KIND
  | typeof FRAME_WIRE_KIND
  | typeof FORMAT_WIRE_KIND;

export interface TemplatePackage {
  v: 3;
  template: TemplateDef;
  frame: Frame;
  formats: Format[];
}

export type ShareWirePayload =
  | { kind: typeof TEMPLATE_WIRE_KIND; package: TemplatePackage }
  | { kind: typeof FRAME_WIRE_KIND; frame: Frame }
  | { kind: typeof FORMAT_WIRE_KIND; format: Format };

export type TemplateWireErrorCode =
  | 'invalid-template'
  | 'invalid-frame'
  | 'invalid-format'
  | 'compression-required'
  | 'empty-pages'
  | 'invalid-page'
  | 'wrong-kind'
  | 'mixed-batch'
  | 'incomplete-pages'
  | 'invalid-transport'
  | 'invalid-json'
  | 'wrong-version';

export class TemplateWireError extends Error {
  readonly code: TemplateWireErrorCode;

  constructor(code: TemplateWireErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'TemplateWireError';
    this.code = code;
  }
}

interface EncodeOptions {
  batchId?: string;
  maxBytes?: number;
}

function fail(code: TemplateWireErrorCode, cause?: unknown): never {
  throw new TemplateWireError(code, cause === undefined ? undefined : { cause });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isShareWireKind(value: string): value is ShareWireKind {
  return value === TEMPLATE_WIRE_KIND || value === FRAME_WIRE_KIND || value === FORMAT_WIRE_KIND;
}

export function buildTemplatePackage(
  template: TemplateDef,
  frames: readonly Frame[],
  formats: readonly Format[],
): TemplatePackage {
  const frame = frames.find((candidate) => candidate.id === template.frameId);
  if (!frame) fail('invalid-frame');
  const referencedIds = new Set(template.placements.map((placement) => placement.formatId));
  const referencedFormats = formats.filter((format) => referencedIds.has(format.id));
  const normalizedFrame = normalizeFrame(frame);
  const normalizedFormats = referencedFormats
    .map(normalizeFormat)
    .filter((format): format is Format => format !== null);
  const normalizedTemplate = normalizeTemplateDef(template, {
    frames: normalizedFrame ? [normalizedFrame] : [],
    formats: normalizedFormats,
  });
  if (!normalizedFrame) fail('invalid-frame');
  if (normalizedFormats.length !== referencedIds.size) fail('invalid-format');
  if (!normalizedTemplate) fail('invalid-template');
  return {
    v: 3,
    template: normalizedTemplate,
    frame: normalizedFrame,
    formats: normalizedFormats,
  };
}

function normalizePayload(payload: ShareWirePayload): {
  kind: ShareWireKind;
  envelope: object;
} {
  if (payload.kind === TEMPLATE_WIRE_KIND) {
    const normalized = buildTemplatePackage(
      payload.package.template,
      [payload.package.frame],
      payload.package.formats,
    );
    return { kind: payload.kind, envelope: normalized };
  }
  if (payload.kind === FRAME_WIRE_KIND) {
    const frame = normalizeFrame(payload.frame);
    if (!frame) fail('invalid-frame');
    return { kind: payload.kind, envelope: { v: 1, frame } };
  }
  const format = normalizeFormat(payload.format);
  if (!format) fail('invalid-format');
  return { kind: payload.kind, envelope: { v: 1, format } };
}

export async function encodeShareWirePages(
  source: ShareWirePayload,
  options: EncodeOptions = {},
): Promise<string[]> {
  const { kind, envelope } = normalizePayload(source);
  let payload: string;
  try {
    // foundation は圧縮後の方が短い時だけ C1 を返す。小さな単独部品も
    // wire 規約どおり C1 にするため、JSON として無害な末尾空白を圧縮用に補う。
    const plain = JSON.stringify(envelope);
    payload = await packPayload(plain.padEnd(Math.max(plain.length, 512), ' '), {
      compress: true,
    });
  } catch (error) {
    fail('compression-required', error);
  }
  if (!payload.startsWith('C1:')) fail('compression-required');

  const maxBytes = options.maxBytes ?? MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= HEADER_BUDGET) fail('invalid-page');
  const pages = encodePages({
    kind,
    payload,
    batchId: options.batchId,
    maxBytes,
  });
  if (pages.length === 0) fail('empty-pages');
  return pages;
}

function decodeAndValidatePages(pageTexts: readonly string[]): {
  kind: ShareWireKind;
  pages: DecodedPage[];
} {
  if (!Array.isArray(pageTexts) || pageTexts.length === 0) fail('empty-pages');
  const decoded: DecodedPage[] = [];
  let kind: ShareWireKind | null = null;
  let batchId: string | null = null;
  let totalPages: number | null = null;
  const seen = new Map<number, string>();

  for (const text of pageTexts) {
    const page = decodePage(text);
    if (!page) fail('invalid-page');
    if (!isShareWireKind(page.kind)) fail('wrong-kind');
    if (
      !Number.isSafeInteger(page.pageNum) ||
      !Number.isSafeInteger(page.totalPages) ||
      page.totalPages < 1 ||
      page.pageNum < 1 ||
      page.pageNum > page.totalPages
    ) {
      fail('invalid-page');
    }
    if (kind === null) kind = page.kind;
    else if (kind !== page.kind) fail('mixed-batch');
    if (batchId === null) batchId = page.batchId;
    else if (batchId !== page.batchId) fail('mixed-batch');
    if (totalPages === null) totalPages = page.totalPages;
    else if (totalPages !== page.totalPages) fail('mixed-batch');

    const prior = seen.get(page.pageNum);
    if (prior !== undefined && prior !== page.content) fail('mixed-batch');
    if (prior === undefined) {
      seen.set(page.pageNum, page.content);
      decoded.push(page);
    }
  }
  if (kind === null || totalPages === null || seen.size !== totalPages) {
    fail('incomplete-pages');
  }
  return { kind, pages: decoded };
}

async function decodeEnvelope(kind: ShareWireKind, payload: string): Promise<ShareWirePayload> {
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

  if (kind === TEMPLATE_WIRE_KIND) {
    if (parsed.v !== 3) fail('wrong-version');
    const frame = normalizeFrame(parsed.frame);
    const formats = (Array.isArray(parsed.formats) ? parsed.formats : [])
      .map(normalizeFormat)
      .filter((format): format is Format => format !== null);
    if (!frame) fail('invalid-frame');
    const template = normalizeTemplateDef(parsed.template, {
      frames: [frame],
      formats,
    });
    if (!template) fail('invalid-template');
    const referencedIds = new Set(template.placements.map((placement) => placement.formatId));
    if (
      formats.length !== (Array.isArray(parsed.formats) ? parsed.formats.length : 0) ||
      formats.some((format) => !referencedIds.has(format.id)) ||
      referencedIds.size !== formats.length
    ) {
      fail('invalid-format');
    }
    return { kind, package: { v: 3, template, frame, formats } };
  }

  if (parsed.v !== 1) fail('wrong-version');
  if (kind === FRAME_WIRE_KIND) {
    const frame = normalizeFrame(parsed.frame);
    if (!frame) fail('invalid-frame');
    return { kind, frame };
  }
  const format = normalizeFormat(parsed.format);
  if (!format) fail('invalid-format');
  return { kind, format };
}

export async function decodeShareWirePages(
  pageTexts: readonly string[],
): Promise<ShareWirePayload> {
  const decoded = decodeAndValidatePages(pageTexts);
  const payload = assemblePages(decoded.pages);
  if (payload === null) fail('incomplete-pages');
  return decodeEnvelope(decoded.kind, payload);
}

export type ShareWireReceiveResult =
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
      payload: ShareWirePayload;
    };

export interface ShareWireCollector {
  receivePage(text: string): Promise<ShareWireReceiveResult>;
  reset(): void;
  progress(): { got: number; total: number };
}

export function createShareWireCollector(): ShareWireCollector {
  let kind: ShareWireKind | null = null;
  let batchId: string | null = null;
  let total = 0;
  const pages = new Map<number, string>();
  const reset = () => {
    kind = null;
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
      if (!isShareWireKind(page.kind)) {
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
      if (batchId !== null && (batchId !== page.batchId || kind !== page.kind)) {
        reset();
        newBatch = true;
      }
      if (batchId === null) {
        kind = page.kind;
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
      if (!kind || !batchId) fail('incomplete-pages');
      const pageTexts: string[] = [];
      for (let n = 1; n <= total; n += 1) {
        const content = pages.get(n);
        if (content === undefined) fail('incomplete-pages');
        pageTexts.push(`RND_${kind} #${batchId} ${n}/${total}\n${content}`);
      }
      const payload = await decodeShareWirePages(pageTexts);
      const completedTotal = total;
      reset();
      return {
        status: 'complete',
        consumed: true,
        got: completedTotal,
        total: completedTotal,
        newBatch,
        payload,
      };
    },
  };
}

export interface ExistingShareEntities {
  templates: readonly TemplateDef[];
  frames: readonly Frame[];
  formats: readonly Format[];
}

/** ID 衝突時だけコピーを採番し、テンプレートパッケージ内の参照も同時に付け替える。 */
export function prepareShareImport(
  payload: ShareWirePayload,
  existing: ExistingShareEntities,
): ShareWirePayload {
  if (payload.kind === FRAME_WIRE_KIND) {
    if (!existing.frames.some((frame) => frame.id === payload.frame.id)) return payload;
    return {
      kind: payload.kind,
      frame: {
        ...payload.frame,
        id: newId('frm'),
        name: uniqueName(
          payload.frame.name,
          existing.frames.map((frame) => frame.name),
        ),
      },
    };
  }
  if (payload.kind === FORMAT_WIRE_KIND) {
    if (!existing.formats.some((format) => format.id === payload.format.id)) return payload;
    return {
      kind: payload.kind,
      format: {
        ...payload.format,
        id: newId('fmt'),
        name: uniqueName(
          payload.format.name,
          existing.formats.map((format) => format.name),
        ),
      },
    };
  }

  const source = payload.package;
  const frameCollides = existing.frames.some((frame) => frame.id === source.frame.id);
  const frame = frameCollides
    ? {
        ...source.frame,
        id: newId('frm'),
        name: uniqueName(
          source.frame.name,
          existing.frames.map((candidate) => candidate.name),
        ),
      }
    : source.frame;
  const formatIdMap = new Map<string, string>();
  const formats = source.formats.map((format) => {
    if (!existing.formats.some((candidate) => candidate.id === format.id)) return format;
    const id = newId('fmt');
    formatIdMap.set(format.id, id);
    return {
      ...format,
      id,
      name: uniqueName(
        format.name,
        existing.formats.map((candidate) => candidate.name),
      ),
    };
  });
  const templateCollides = existing.templates.some(
    (template) => template.id === source.template.id,
  );
  const template: TemplateDef = {
    ...source.template,
    id: templateCollides ? newId('tpl') : source.template.id,
    name: templateCollides
      ? uniqueName(
          source.template.name,
          existing.templates.map((candidate) => candidate.name),
        )
      : source.template.name,
    frameId: frame.id,
    placements: source.template.placements.map((placement) => ({
      ...placement,
      // コピー採番時は配置 ID も付け替える。維持すると元テンプレートとコピーが
      // projectedValues のキーを共有し、対象の入力値が 2 テンプレート間で連動してしまう。
      id: templateCollides ? newId('plm') : placement.id,
      formatId: formatIdMap.get(placement.formatId) ?? placement.formatId,
    })),
  };
  return {
    kind: payload.kind,
    package: { v: 3, template, frame, formats },
  };
}

export function sharePayloadName(payload: ShareWirePayload): string {
  if (payload.kind === TEMPLATE_WIRE_KIND) return payload.package.template.name;
  if (payload.kind === FRAME_WIRE_KIND) return payload.frame.name;
  return payload.format.name;
}
