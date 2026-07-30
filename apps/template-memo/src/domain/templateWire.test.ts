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
import { normalizeTemplate, type Template } from './template';
import {
  createTemplateWireCollector,
  decodeTemplateWirePages,
  encodeTemplateWirePages,
  summarizeTemplate,
  TEMPLATE_WIRE_KIND,
  type TemplateWireErrorCode,
} from './templateWire';

function fixtureTemplate(): Template {
  return {
    id: 'tpl_fixture',
    name: '受け渡しテスト',
    includeProblems: true,
    includeHandover: false,
    memoSectionId: 'sec_o',
    updatedAt: 123,
    sections: [
      {
        id: 'sec_s',
        title: '(S)',
        keepWhenEmpty: true,
        freeText: true,
        normal: '変わりない',
        groups: [],
      },
      {
        id: 'sec_o',
        title: '(O)',
        keepWhenEmpty: true,
        freeText: true,
        groups: [
          {
            id: 'grp_vital',
            name: 'バイタル',
            display: 'always',
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
            id: 'grp_lab',
            name: '検査',
            display: 'oncall',
            joiner: '\n',
            labelSep: '：',
            titleWrap: '（）',
            items: [
              { id: 'itm_blood', label: '採血', kind: 'text' },
              { id: 'itm_xp', label: '胸部Xp', kind: 'text' },
            ],
          },
          {
            id: 'grp_menu',
            name: '画像所見',
            display: 'menu',
            joiner: '\n',
            labelSep: '：',
            titleWrap: '',
            items: [{ id: 'itm_ct', label: 'CT', kind: 'text' }],
          },
        ],
      },
    ],
  };
}

async function packedPagesForPlain(plain: string, batchId = 'bad'): Promise<string[]> {
  const packed = await packPayload(plain, { compress: true });
  expect(packed.startsWith('C1:')).toBe(true);
  return encodePages({
    kind: TEMPLATE_WIRE_KIND,
    payload: packed,
    batchId,
    maxBytes: 100,
  });
}

async function expectWireError(
  promise: Promise<unknown>,
  code: TemplateWireErrorCode,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('template wire roundtrip', () => {
  it('Template だけを C1/TPL ページへし、順不同・重複でも正規化して復元する', async () => {
    const source = fixtureTemplate();
    // ランタイム上の余分な欄があっても wire へは載せない。
    const withUnknown = {
      ...source,
      subjectSecret: { name: '載せてはいけない対象' },
    } as Template;
    const pages = await encodeTemplateWirePages(withUnknown, {
      batchId: 'roundtrip',
      maxBytes: 100,
    });

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.startsWith('RND_TPL #roundtrip ')).toBe(true);
      expect(utf8ByteLength(page)).toBeLessThanOrEqual(100);
    }

    const decodedPages = pages.map((page) => decodePage(page)) as DecodedPage[];
    const transport = assemblePages(decodedPages);
    expect(transport?.startsWith('C1:')).toBe(true);
    const plain = await unpackPayload(transport ?? '');
    const envelope = JSON.parse(plain) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(['template', 'v']);
    expect((envelope.template as Record<string, unknown>).subjectSecret).toBeUndefined();

    const shuffledWithDuplicate = [
      ...pages.slice().reverse(),
      pages[0] as string,
      pages[pages.length - 1] as string,
    ];
    await expect(decodeTemplateWirePages(shuffledWithDuplicate)).resolves.toEqual(
      normalizeTemplate(source),
    );
  });

  it('件数サマリーは section/group/item を全階層で数える', () => {
    expect(summarizeTemplate(fixtureTemplate())).toEqual({
      sections: 2,
      groups: 3,
      items: 7,
    });
  });
});

describe('template wire fail-closed', () => {
  it('壊れた base64 と解凍不能 C1 を拒否する', async () => {
    const brokenBase64 = encodePages({
      kind: TEMPLATE_WIRE_KIND,
      payload: 'C1:not valid base64!',
      batchId: 'b64',
    });
    await expectWireError(decodeTemplateWirePages(brokenBase64), 'invalid-transport');

    const notDeflate = encodePages({
      kind: TEMPLATE_WIRE_KIND,
      payload: 'C1:YWJj',
      batchId: 'inflate',
    });
    await expectWireError(decodeTemplateWirePages(notDeflate), 'invalid-transport');
  });

  it('JSON 不正・version 不一致・normalizeTemplate null を拒否する', async () => {
    await expectWireError(
      decodeTemplateWirePages(await packedPagesForPlain(`{broken${'x'.repeat(600)}`, 'json')),
      'invalid-json',
    );
    await expectWireError(
      decodeTemplateWirePages(
        await packedPagesForPlain(
          JSON.stringify({ v: 2, template: fixtureTemplate(), pad: 'x'.repeat(600) }),
          'version',
        ),
      ),
      'wrong-version',
    );
    await expectWireError(
      decodeTemplateWirePages(
        await packedPagesForPlain(
          JSON.stringify({
            v: 1,
            template: { id: 'broken', name: 'broken', sections: [] },
            pad: 'x'.repeat(600),
          }),
          'template',
        ),
      ),
      'invalid-template',
    );
  });

  it('平文 transport・kind 違い・ページ欠落・バッチ混在を拒否する', async () => {
    const plain = encodePages({
      kind: TEMPLATE_WIRE_KIND,
      payload: JSON.stringify({ v: 1, template: fixtureTemplate() }),
      batchId: 'plain',
    });
    await expectWireError(decodeTemplateWirePages(plain), 'invalid-transport');

    const wrongKind = encodePages({
      kind: 'HM',
      payload: 'C1:YWJj',
      batchId: 'kind',
    });
    await expectWireError(decodeTemplateWirePages(wrongKind), 'wrong-kind');

    const pages = await encodeTemplateWirePages(fixtureTemplate(), {
      batchId: 'complete',
      maxBytes: 100,
    });
    await expectWireError(decodeTemplateWirePages(pages.slice(1)), 'incomplete-pages');

    const other = await encodeTemplateWirePages(fixtureTemplate(), {
      batchId: 'other',
      maxBytes: 100,
    });
    await expectWireError(
      decodeTemplateWirePages([pages[0] as string, ...other.slice(1)]),
      'mixed-batch',
    );
  });
});

describe('incremental collector', () => {
  it('順不同・重複ページを集め、完成時だけ Template を返す', async () => {
    const source = fixtureTemplate();
    const pages = await encodeTemplateWirePages(source, {
      batchId: 'collector',
      maxBytes: 100,
    });
    expect(pages.length).toBeGreaterThan(2);
    const collector = createTemplateWireCollector();
    const reversed = pages.slice().reverse();

    const first = await collector.receivePage(reversed[0] as string);
    expect(first).toMatchObject({ status: 'progress', got: 1, total: pages.length });
    const duplicate = await collector.receivePage(reversed[0] as string);
    expect(duplicate).toMatchObject({ status: 'duplicate', got: 1, total: pages.length });

    let final: Awaited<ReturnType<typeof collector.receivePage>> | null = null;
    for (const page of reversed.slice(1)) final = await collector.receivePage(page);
    expect(final).toMatchObject({
      status: 'complete',
      got: pages.length,
      total: pages.length,
      template: normalizeTemplate(source),
    });
    expect(collector.progress()).toEqual({ got: 0, total: 0 });
  });

  it('形式/kind 不一致は consumed=false で既存進捗を維持する', async () => {
    const pages = await encodeTemplateWirePages(fixtureTemplate(), {
      batchId: 'keep',
      maxBytes: 100,
    });
    const collector = createTemplateWireCollector();
    await collector.receivePage(pages[0] as string);
    const before = collector.progress();

    await expect(collector.receivePage('not a qr page')).resolves.toMatchObject({
      status: 'rejected',
      consumed: false,
      reason: 'invalid-page',
    });
    const wrongKind = encodePages({
      kind: 'HM',
      payload: 'payload',
      batchId: 'wrong',
    })[0] as string;
    await expect(collector.receivePage(wrongKind)).resolves.toMatchObject({
      status: 'rejected',
      consumed: false,
      reason: 'wrong-kind',
      gotKind: 'HM',
    });
    expect(collector.progress()).toEqual(before);
  });

  it('同じページ番号で内容が異なる断片は拒否し、既存進捗を維持する', async () => {
    const pages = await encodeTemplateWirePages(fixtureTemplate(), {
      batchId: 'conflict',
      maxBytes: 100,
    });
    const collector = createTemplateWireCollector();
    const first = decodePage(pages[0] as string);
    expect(first).not.toBeNull();
    await collector.receivePage(pages[0] as string);
    const before = collector.progress();
    const conflicting =
      `RND_${TEMPLATE_WIRE_KIND} #${first?.batchId} ${first?.pageNum}/${first?.totalPages}\n` +
      `${first?.content}x`;

    await expect(collector.receivePage(conflicting)).resolves.toMatchObject({
      status: 'rejected',
      consumed: false,
      reason: 'invalid-page',
    });
    expect(collector.progress()).toEqual(before);
  });
});
