// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { packPayload, unpackPayload } from '@snishi/foundation/qr/crypto';
import {
  assemblePages,
  decodePage,
  encodePages,
  utf8ByteLength,
  type DecodedPage,
} from '@snishi/foundation/qr/protocol';
import type { Format, Frame, TemplateDef } from './entities';
import {
  createShareWireCollector,
  decodeShareWirePages,
  encodeShareWirePages,
  FORMAT_WIRE_KIND,
  FRAME_WIRE_KIND,
  prepareShareImport,
  TEMPLATE_WIRE_KIND,
  type ShareWireKind,
  type ShareWirePayload,
  type TemplateWireErrorCode,
} from './templateWire';

function fixture(): {
  frame: Frame;
  formats: Format[];
  template: TemplateDef;
  payload: ShareWirePayload;
} {
  const frame: Frame = {
    id: 'frm_soap',
    name: 'SOAP',
    sections: [
      { id: 'sec_s', title: '(S)', freeText: true, normal: '変わりない' },
      { id: 'sec_o', title: '(O)', freeText: true },
    ],
  };
  const formats: Format[] = [
    {
      id: 'fmt_vital',
      name: 'バイタル',
      joiner: ', ',
      labelSep: ' ',
      titleWrap: '',
      items: [
        { id: 'itm_bp', label: 'BP', kind: 'fraction', unit: 'mmHg' },
        { id: 'itm_hr', label: 'HR', kind: 'number' },
        { id: 'itm_lung', label: '肺音', kind: 'text', normal: '明らかなラ音なし' },
        {
          id: 'itm_course',
          label: '方針',
          kind: 'select',
          options: ['経過観察', '精査'],
        },
      ],
    },
    {
      id: 'fmt_lab',
      name: '検査',
      joiner: '\n',
      labelSep: '：',
      titleWrap: '（）',
      items: [
        { id: 'itm_blood', label: '採血', kind: 'text' },
        { id: 'itm_xp', label: '胸部Xp', kind: 'text' },
        { id: 'itm_ct', label: 'CT', kind: 'text' },
      ],
    },
  ];
  const template: TemplateDef = {
    id: 'tpl_fixture',
    name: '受け渡しテスト',
    frameId: frame.id,
    includeProblems: true,
    includeHandover: false,
    placements: [
      {
        id: 'plm_vital',
        sectionId: 'sec_o',
        formatId: formats[0]!.id,
        display: 'always',
      },
      {
        id: 'plm_lab',
        sectionId: 'sec_o',
        formatId: formats[1]!.id,
        display: 'oncall',
      },
    ],
    updatedAt: 123,
  };
  return {
    frame,
    formats,
    template,
    payload: {
      kind: TEMPLATE_WIRE_KIND,
      package: { v: 3, template, frame, formats },
    },
  };
}

async function packedPagesForPlain(
  kind: ShareWireKind,
  plain: string,
  batchId = 'bad',
): Promise<string[]> {
  const packed = await packPayload(plain, { compress: true });
  expect(packed.startsWith('C1:')).toBe(true);
  return encodePages({ kind, payload: packed, batchId, maxBytes: 100 });
}

async function expectWireError(
  promise: Promise<unknown>,
  code: TemplateWireErrorCode,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('share wire roundtrip', () => {
  it('TPL v3 は参照部品だけを同梱し、機密データ用キーを載せない', async () => {
    const source = fixture();
    const withUnknown = {
      ...source.payload,
      patients: [{ name: '秘密' }],
      places: [{ name: '病棟' }],
      projectedValues: { secret: '値' },
    } as unknown as ShareWirePayload;
    const pages = await encodeShareWirePages(withUnknown, {
      batchId: 'roundtrip',
      maxBytes: 100,
    });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.startsWith('RND_TPL #roundtrip ')).toBe(true);
      expect(utf8ByteLength(page)).toBeLessThanOrEqual(100);
    }
    const decodedPages = pages.map((page) => decodePage(page)) as DecodedPage[];
    const plain = await unpackPayload(assemblePages(decodedPages) ?? '');
    expect(plain).not.toContain('"patients"');
    expect(plain).not.toContain('"places"');
    expect(plain).not.toContain('"projectedValues"');
    await expect(decodeShareWirePages([...pages.slice().reverse(), pages[0]!])).resolves.toEqual(
      source.payload,
    );
  });

  // 完了走査の唯一の例外: 「memoSectionId 入り v3 fixture テスト」。
  // 旧端末が送った TPL v3 には廃止済みの memoSectionId が載っている。wire 版は据え置きなので、
  // 取り込めること（拒否しない）と、結果に旧キーが残らないこと（未知キーとして落ちる）を固定する。
  it('旧 v3 パッケージの memoSectionId は取込を壊さず、結果にも残らない', async () => {
    const source = fixture();
    const legacy = {
      kind: TEMPLATE_WIRE_KIND,
      package: {
        v: 3,
        template: { ...source.template, memoSectionId: 'sec_o' },
        frame: source.frame,
        formats: source.formats,
      },
    } as unknown as ShareWirePayload;
    // 送信側の正規化を通さず、旧端末が作った plain JSON をそのままページ化する。
    const pages = await packedPagesForPlain(
      TEMPLATE_WIRE_KIND,
      JSON.stringify({
        v: 3,
        template: { ...source.template, memoSectionId: 'sec_o' },
        frame: source.frame,
        formats: source.formats,
      }),
      'legacy-memo',
    );
    const decoded = await decodeShareWirePages(pages);
    expect(decoded).toEqual(source.payload);
    expect(JSON.stringify(decoded)).not.toContain('memoSectionId');
    // 送信側でも旧キーは新パッケージに載らない（entities から消えているため）。
    const reEncoded = await encodeShareWirePages(legacy, { batchId: 'legacy-out', maxBytes: 100 });
    await expect(decodeShareWirePages(reEncoded)).resolves.toEqual(source.payload);
  });

  it.each([
    [
      FRAME_WIRE_KIND,
      () => ({ kind: FRAME_WIRE_KIND, frame: fixture().frame }) satisfies ShareWirePayload,
    ],
    [
      FORMAT_WIRE_KIND,
      () =>
        ({
          kind: FORMAT_WIRE_KIND,
          format: fixture().formats[0]!,
        }) satisfies ShareWirePayload,
    ],
  ] as const)('%s v1 を単独で往復する', async (_kind, build) => {
    const payload = build();
    const pages = await encodeShareWirePages(payload, {
      batchId: `single-${payload.kind}`,
      maxBytes: 100,
    });
    await expect(decodeShareWirePages(pages)).resolves.toEqual(payload);
  });
});

describe('share wire fail-closed', () => {
  it('TPL v2以前と単独部品のversion不一致を拒否する', async () => {
    const source = fixture();
    await expectWireError(
      decodeShareWirePages(
        await packedPagesForPlain(
          TEMPLATE_WIRE_KIND,
          JSON.stringify({
            v: 2,
            template: source.template,
            frame: source.frame,
            formats: source.formats,
            pad: 'x'.repeat(600),
          }),
        ),
      ),
      'wrong-version',
    );
    await expectWireError(
      decodeShareWirePages(
        await packedPagesForPlain(
          FRAME_WIRE_KIND,
          JSON.stringify({ v: 2, frame: source.frame, pad: 'x'.repeat(600) }),
        ),
      ),
      'wrong-version',
    );
  });

  it('壊れたtransport・kind違い・ページ欠落を拒否する', async () => {
    const broken = encodePages({
      kind: TEMPLATE_WIRE_KIND,
      payload: 'C1:not valid base64!',
      batchId: 'broken',
    });
    await expectWireError(decodeShareWirePages(broken), 'invalid-transport');
    const wrongKind = encodePages({ kind: 'HM', payload: 'C1:YWJj', batchId: 'kind' });
    await expectWireError(decodeShareWirePages(wrongKind), 'wrong-kind');
    const pages = await encodeShareWirePages(fixture().payload, {
      batchId: 'missing',
      maxBytes: 100,
    });
    await expectWireError(decodeShareWirePages(pages.slice(1)), 'incomplete-pages');
  });
});

describe('safe import', () => {
  it('パッケージ内の全ID衝突をコピーへ変換し、参照IDも付け替える', () => {
    const source = fixture();
    const imported = prepareShareImport(source.payload, {
      templates: [source.template],
      frames: [source.frame],
      formats: source.formats,
    });
    expect(imported.kind).toBe(TEMPLATE_WIRE_KIND);
    if (imported.kind !== TEMPLATE_WIRE_KIND) return;
    expect(imported.package.template.id).not.toBe(source.template.id);
    expect(imported.package.frame.id).not.toBe(source.frame.id);
    expect(imported.package.template.frameId).toBe(imported.package.frame.id);
    expect(imported.package.formats.map((format) => format.id)).not.toEqual(
      source.formats.map((format) => format.id),
    );
    expect(imported.package.template.placements.map((placement) => placement.formatId)).toEqual(
      imported.package.formats.map((format) => format.id),
    );
    // 配置 ID も再採番する。維持すると元とコピーが projectedValues キーを共有し、
    // 同一パッケージの二重取り込みで対象の入力値が 2 テンプレート間で連動してしまう。
    const sourceIds = new Set(source.template.placements.map((placement) => placement.id));
    for (const placement of imported.package.template.placements) {
      expect(sourceIds.has(placement.id)).toBe(false);
    }
  });

  it('衝突がなければIDを維持する', () => {
    const source = fixture().payload;
    expect(prepareShareImport(source, { templates: [], frames: [], formats: [] })).toEqual(source);
  });
});

describe('incremental collector', () => {
  it('3 kind のページを順不同・重複込みで完成させる', async () => {
    const source = fixture().payload;
    const pages = await encodeShareWirePages(source, {
      batchId: 'collector',
      maxBytes: 100,
    });
    const collector = createShareWireCollector();
    const reversed = pages.slice().reverse();
    await expect(collector.receivePage(reversed[0]!)).resolves.toMatchObject({
      status: 'progress',
      got: 1,
    });
    await expect(collector.receivePage(reversed[0]!)).resolves.toMatchObject({
      status: 'duplicate',
      got: 1,
    });
    let final: Awaited<ReturnType<typeof collector.receivePage>> | null = null;
    for (const page of reversed.slice(1)) final = await collector.receivePage(page);
    expect(final).toMatchObject({ status: 'complete', payload: source });
    expect(collector.progress()).toEqual({ got: 0, total: 0 });
  });

  it('未知kindは進捗を消費しない', async () => {
    const pages = await encodeShareWirePages(fixture().payload, {
      batchId: 'keep',
      maxBytes: 100,
    });
    const collector = createShareWireCollector();
    await collector.receivePage(pages[0]!);
    const before = collector.progress();
    const wrongKind = encodePages({
      kind: 'HM',
      payload: 'payload',
      batchId: 'wrong',
    })[0]!;
    await expect(collector.receivePage(wrongKind)).resolves.toMatchObject({
      status: 'rejected',
      consumed: false,
      reason: 'wrong-kind',
      gotKind: 'HM',
    });
    expect(collector.progress()).toEqual(before);
  });
});
