import { describe, expect, it } from 'vitest';
import {
  BUILDER_EXPECTED_JSON,
  BUILDER_RESPONSE_MAX_CHARS,
  buildBundleFromCandidate,
  extractJsonText,
  parseBuilderResponse,
  type BuilderParseErrorCode,
} from './templateBuilder';

describe('extractJsonText', () => {
  it('JSON 全文をそのまま返す', () => {
    expect(extractJsonText('{"ok":true}')).toBe('{"ok":true}');
  });

  it('json 指定あり・なしのコードフェンスから取り出す', () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonText('```\n{"b":2}\n```')).toBe('{"b":2}');
  });

  it('複数フェンスでは最初に読める JSON を選ぶ', () => {
    expect(extractJsonText('```json\n{broken}\n```\n説明\n```json\n{"valid":3}\n```')).toBe(
      '{"valid":3}',
    );
  });

  it('前後の散文から文字列内の波括弧を壊さず object を切り出す', () => {
    expect(extractJsonText('結果です。\n{"message":"{中括弧}","nested":{"x":1}}\n以上です。')).toBe(
      '{"message":"{中括弧}","nested":{"x":1}}',
    );
  });

  it('途中で切れた object は閉じ波括弧なしのまま返す', () => {
    expect(extractJsonText('返答:\n{"frame":{"name":"途中"')).toBe('{"frame":{"name":"途中"');
  });

  it('空文字列は空のまま返す', () => {
    expect(extractJsonText('  ')).toBe('');
  });
});

function expectedResponse(requestId = 'req_test'): Record<string, unknown> {
  return JSON.parse(
    BUILDER_EXPECTED_JSON.replace('<依頼文の requestId をそのまま返す>', requestId),
  ) as Record<string, unknown>;
}

function expectError(text: string, requestId: string, code: BuilderParseErrorCode): void {
  expect(parseBuilderResponse(text, requestId)).toEqual({ ok: false, code });
}

describe('parseBuilderResponse', () => {
  it('期待JSON例をwarningなしの候補へ変換する', () => {
    const parsed = parseBuilderResponse(JSON.stringify(expectedResponse()), 'req_test');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings).toEqual([]);
    expect(parsed.candidate.frame.sections).toHaveLength(2);
    expect(
      parsed.candidate.formats.flatMap((format) => format.items).map((item) => item.kind),
    ).toEqual(['number', 'fraction', 'select', 'text']);
  });

  it.each<[string, string, BuilderParseErrorCode]>([
    ['', 'req', 'empty'],
    ['{broken}', 'req', 'invalid-json'],
    ['[]', 'req', 'not-object'],
    [JSON.stringify({ ...expectedResponse('req'), kind: 'other' }), 'req', 'wrong-kind'],
    [JSON.stringify({ ...expectedResponse('req'), version: 2 }), 'req', 'wrong-version'],
    [JSON.stringify(expectedResponse('old')), 'req', 'request-mismatch'],
    ['{"kind":"template-memo-builder","frame":{', 'req', 'truncated'],
    [
      JSON.stringify({
        ...expectedResponse('req'),
        frame: { name: '空', sections: [] },
      }),
      'req',
      'no-sections',
    ],
  ])('%s を %s として拒否する', (text, requestId, code) => {
    expectError(text, requestId, code);
  });

  it('文字数上限を超えた返答をJSON解析前に拒否する', () => {
    expectError('x'.repeat(BUILDER_RESPONSE_MAX_CHARS + 1), 'req', 'too-large');
  });

  it('選択肢1個のselectをtextへ降格し、未解決配置を落として警告する', () => {
    const raw = expectedResponse();
    raw.formats = [
      {
        key: 'fmt_one',
        name: '判定',
        joiner: '\n',
        labelSep: '：',
        items: [{ label: '状態', kind: 'select', options: ['良好'] }],
      },
    ];
    raw.template = {
      name: '点検',
      memoSectionKey: 'missing',
      includeProblems: false,
      includeHandover: false,
      placements: [{ sectionKey: 'sec_summary', formatKey: 'missing', display: 'always' }],
    };
    const parsed = parseBuilderResponse(JSON.stringify(raw), 'req_test');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.candidate.formats[0]?.items[0]).toEqual({ label: '状態', kind: 'text' });
    expect(parsed.candidate.template.placements).toEqual([]);
    expect(parsed.candidate.template.memoSectionKey).toBeUndefined();
    expect(parsed.warnings.map((warning) => warning.code)).toEqual([
      'select-downgraded',
      'unresolved-placement',
      'unresolved-memo',
    ]);
  });

  it('menu と未知の表示方法は展開へ寄せるが、黙らせず警告する', () => {
    const raw = expectedResponse();
    const template = raw.template as Record<string, unknown>;
    template.placements = [
      { sectionKey: 'sec_readings', formatKey: 'fmt_readings', display: 'menu' },
      { sectionKey: 'sec_summary', formatKey: 'fmt_appearance', display: 'いつでも' },
    ];
    const parsed = parseBuilderResponse(JSON.stringify(raw), 'req_test');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.candidate.template.placements.map((placement) => placement.display)).toEqual([
      'always',
      'always',
    ]);
    expect(parsed.warnings.map((warning) => warning.code)).toEqual([
      'display-coerced',
      'display-coerced',
    ]);
  });

  it('key の無い場所とフォーマットは黙って消さず警告する', () => {
    const raw = expectedResponse();
    const frame = raw.frame as { sections: unknown[] };
    frame.sections = [...frame.sections, { title: 'key なし', freeText: true }, 'まるごと不正'];
    raw.formats = [...(raw.formats as unknown[]), { name: 'key なし', items: [] }];
    const parsed = parseBuilderResponse(JSON.stringify(raw), 'req_test');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.candidate.frame.sections).toHaveLength(2);
    expect(parsed.candidate.formats).toHaveLength(2);
    expect(parsed.warnings.map((warning) => warning.code)).toEqual([
      'invalid-section',
      'invalid-section',
      'invalid-format',
    ]);
  });

  it('重複keyは先勝ちにし、AIのwarningを候補へ残す', () => {
    const raw = expectedResponse();
    const frame = raw.frame as { sections: unknown[] };
    frame.sections.push({ key: 'sec_summary', title: '重複', freeText: false });
    raw.warnings = ['種類を判断できませんでした'];
    const parsed = parseBuilderResponse(JSON.stringify(raw), 'req_test');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.candidate.frame.sections).toHaveLength(2);
    expect(parsed.candidate.aiWarnings).toEqual(['種類を判断できませんでした']);
    expect(parsed.warnings.map((warning) => warning.code)).toContain('duplicate-key');
  });
});

describe('buildBundleFromCandidate', () => {
  it('AI由来idを使わず全採番し、同じ候補から2回作っても全IDが異なる', () => {
    const raw = expectedResponse();
    raw.id = 'tpl_existing';
    (raw.frame as Record<string, unknown>).id = 'frm_existing';
    for (const section of (raw.frame as { sections: Record<string, unknown>[] }).sections) {
      section.id = 'sec_existing';
    }
    for (const format of raw.formats as Record<string, unknown>[]) {
      format.id = 'fmt_existing';
      for (const item of format.items as Record<string, unknown>[]) item.id = 'itm_existing';
    }
    const parsed = parseBuilderResponse(JSON.stringify(raw), 'req_test');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const first = buildBundleFromCandidate(parsed.candidate);
    const second = buildBundleFromCandidate(parsed.candidate);
    const ids = (result: typeof first) => [
      result.bundle.frame.id,
      ...result.bundle.frame.sections.map((section) => section.id),
      ...result.bundle.formats.flatMap((format) => [
        format.id,
        ...format.items.map((item) => item.id),
      ]),
      result.bundle.template.id,
      ...result.bundle.template.placements.map((placement) => placement.id),
    ];
    expect(ids(first)).not.toEqual(ids(second));
    expect(ids(first).some((id) => id.endsWith('_existing'))).toBe(false);
    expect(first.warnings).toEqual([]);
  });

  it('場所normalを作らずtitleWrapを空にし、memo場所をfreeText=trueへ固定する', () => {
    const raw = expectedResponse();
    const frame = raw.frame as { sections: Record<string, unknown>[] };
    frame.sections[1]!.normal = 'AIが作った場所の正常文';
    const template = raw.template as Record<string, unknown>;
    template.memoSectionKey = 'sec_readings';
    const parsed = parseBuilderResponse(JSON.stringify(raw), 'req_test');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { bundle, warnings } = buildBundleFromCandidate(parsed.candidate);
    expect(bundle.frame.sections.every((section) => section.normal === undefined)).toBe(true);
    expect(
      bundle.frame.sections.find((section) => section.id === bundle.template.memoSectionId)
        ?.freeText,
    ).toBe(true);
    expect(bundle.formats.every((format) => format.titleWrap === '')).toBe(true);
    expect(bundle.template.placements.every((placement) => placement.display !== 'menu')).toBe(
      true,
    );
    expect(warnings).toEqual([]);
  });

  it('お手本JSONの配置が実IDへ解決され、フォーマットが場所へ置かれる', () => {
    // お手本 (few-shot) が「配置ゼロ」だと、AI もフォーマットをどこにも置かない返答を真似る。
    // 生成物の入力欄が空になる事故を防ぐため、配置が実際に解決されることを固定する。
    const parsed = parseBuilderResponse(JSON.stringify(expectedResponse()), 'req_test');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { bundle, warnings } = buildBundleFromCandidate(parsed.candidate);

    expect(bundle.template.placements).toHaveLength(2);
    const sectionIds = new Set(bundle.frame.sections.map((section) => section.id));
    const formatIds = new Set(bundle.formats.map((format) => format.id));
    for (const placement of bundle.template.placements) {
      expect(sectionIds.has(placement.sectionId)).toBe(true);
      expect(formatIds.has(placement.formatId)).toBe(true);
    }
    // always / oncall の両方を示す例であること（display の書き分けの手本になる）。
    expect(new Set(bundle.template.placements.map((placement) => placement.display))).toEqual(
      new Set(['always', 'oncall']),
    );
    // すべてのフォーマットがどこかへ配置されている（使われない部品を作らせない）。
    expect(new Set(bundle.template.placements.map((placement) => placement.formatId))).toEqual(
      formatIds,
    );
    expect(warnings).toEqual([]);
  });
});
