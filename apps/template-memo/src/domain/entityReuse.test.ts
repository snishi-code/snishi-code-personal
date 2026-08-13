/*
 * 構造一致（名前・ID 無視）の判定と、生成一式の再利用計画。
 * store.saveGeneratedBundle と確認画面（TemplateBuilder）はどちらもこの計画を使うため、
 * ここで固定した挙動が「見せた内容」と「登録される形」の唯一の正本になる。
 */

import { describe, expect, it } from 'vitest';
import { formatStructureEquals, frameStructureEquals, planBundleReuse } from './entityReuse';
import type { Format, Frame, TemplateDef } from './entities';
import type { TemplatePresetBundle } from './presets';

const frame: Frame = {
  id: 'frame-soap',
  name: 'SOAP',
  sections: [
    { id: 'section-s', title: '(S)', freeText: true, normal: '変わりない' },
    { id: 'section-o', title: '(O)', freeText: false },
  ],
};

const format: Format = {
  id: 'format-vitals',
  name: 'バイタル',
  joiner: ', ',
  labelSep: ' ',
  titleWrap: '',
  items: [
    { id: 'item-bp', label: 'BP', kind: 'text', unit: 'mmHg' },
    { id: 'item-mode', label: '運転モード', kind: 'select', options: ['自動', '手動'] },
  ],
};

function bundleOf(frameValue: Frame, formats: Format[]): TemplatePresetBundle {
  const template: TemplateDef = {
    id: 'template-generated',
    name: '生成テンプレート',
    frameId: frameValue.id,
    includeProblems: false,
    includeHandover: false,
    placements: formats.map((candidate, index) => ({
      id: `placement-${index}`,
      sectionId: frameValue.sections[0]!.id,
      formatId: candidate.id,
      display: 'always' as const,
    })),
    updatedAt: 0,
  };
  return { frame: frameValue, formats, template };
}

describe('フォーマットの構造一致', () => {
  it('名前と ID だけが違うフォーマットは一致とみなす', () => {
    const renamed: Format = {
      ...format,
      id: 'format-other',
      name: 'vital signs',
      items: format.items.map((item, index) => ({ ...item, id: `other-item-${index}` })),
    };
    expect(formatStructureEquals(format, renamed)).toBe(true);
  });

  it('項目 1 個の単位違いは不一致', () => {
    const changed: Format = {
      ...format,
      items: [{ ...format.items[0]!, unit: 'kPa' }, format.items[1]!],
    };
    expect(formatStructureEquals(format, changed)).toBe(false);
  });

  it('選択肢の順序違いは不一致', () => {
    const changed: Format = {
      ...format,
      items: [format.items[0]!, { ...format.items[1]!, options: ['手動', '自動'] }],
    };
    expect(formatStructureEquals(format, changed)).toBe(false);
  });

  it('ラベル・区切り・項目数・showLabel の違いは不一致', () => {
    expect(
      formatStructureEquals(format, {
        ...format,
        items: [{ ...format.items[0]!, label: '血圧' }, format.items[1]!],
      }),
    ).toBe(false);
    expect(formatStructureEquals(format, { ...format, joiner: '\n' })).toBe(false);
    expect(formatStructureEquals(format, { ...format, labelSep: '：' })).toBe(false);
    expect(formatStructureEquals(format, { ...format, titleWrap: '（）' })).toBe(false);
    expect(formatStructureEquals(format, { ...format, items: [format.items[0]!] })).toBe(false);
    expect(
      formatStructureEquals(format, {
        ...format,
        items: [{ ...format.items[0]!, showLabel: false }, format.items[1]!],
      }),
    ).toBe(false);
  });

  it('正常文の未定義と空文字は同じ扱い（normalize 後の揺れを一致とみなす）', () => {
    const text: Format = {
      ...format,
      items: [{ id: 'item-text', label: '外装', kind: 'text', normal: '' }],
    };
    const same: Format = {
      ...format,
      items: [{ id: 'item-text-2', label: '外装', kind: 'text' }],
    };
    expect(formatStructureEquals(text, same)).toBe(true);
    expect(
      formatStructureEquals(text, {
        ...text,
        items: [{ id: 'item-text-3', label: '外装', kind: 'text', normal: '異常なし' }],
      }),
    ).toBe(false);
  });
});

describe('フレームの構造一致', () => {
  it('名前と ID だけが違うフレームは一致とみなす', () => {
    const renamed: Frame = {
      id: 'frame-other',
      name: 'soap sheet',
      sections: frame.sections.map((section, index) => ({ ...section, id: `other-sec-${index}` })),
    };
    expect(frameStructureEquals(frame, renamed)).toBe(true);
  });

  it('場所の見出し・自由本文の有無・正常文・場所数の違いは不一致', () => {
    expect(
      frameStructureEquals(frame, {
        ...frame,
        sections: [{ ...frame.sections[0]!, title: '(Ｓ)' }, frame.sections[1]!],
      }),
    ).toBe(false);
    expect(
      frameStructureEquals(frame, {
        ...frame,
        sections: [frame.sections[0]!, { ...frame.sections[1]!, freeText: true }],
      }),
    ).toBe(false);
    expect(
      frameStructureEquals(frame, {
        ...frame,
        sections: [{ ...frame.sections[0]!, normal: '著変なし' }, frame.sections[1]!],
      }),
    ).toBe(false);
    expect(frameStructureEquals(frame, { ...frame, sections: [frame.sections[0]!] })).toBe(false);
  });
});

describe('生成一式の再利用計画', () => {
  it('バンドル内の名前違い・同構造は 1 つへ統合し、名前は先に現れた候補を採る', () => {
    const second: Format = {
      ...format,
      id: 'format-dup',
      name: 'ばいたる',
      items: format.items.map((item, index) => ({ ...item, id: `dup-item-${index}` })),
    };
    const plan = planBundleReuse(bundleOf(frame, [format, second]), [], []);

    expect(plan.formats).toHaveLength(1);
    expect(plan.formats[0]!.candidate.name).toBe('バイタル');
    expect(plan.formats[0]!.mergedIds).toEqual(['format-vitals', 'format-dup']);
    expect(plan.formatPlanById.get('format-dup')).toBe(plan.formats[0]);
    expect(plan.formats[0]!.existing).toBeNull();
  });

  it('既存に構造一致があれば配列順の先頭を再利用先にする（名前は無視）', () => {
    const first: Format = { ...format, id: 'existing-1', name: 'バイタル (2)' };
    const second: Format = { ...format, id: 'existing-2', name: 'vital signs' };
    const plan = planBundleReuse(bundleOf(frame, [format]), [], [second, first]);
    expect(plan.formats[0]!.existing?.id).toBe('existing-2');
  });

  it('フレーム再利用では場所 ID を index 対応で読み替える', () => {
    const existing: Frame = {
      id: 'existing-frame',
      name: '別名',
      sections: [
        { id: 'existing-s', title: '(S)', freeText: true, normal: '変わりない' },
        { id: 'existing-o', title: '(O)', freeText: false },
      ],
    };
    const plan = planBundleReuse(bundleOf(frame, []), [existing], []);

    expect(plan.frame.existing?.id).toBe('existing-frame');
    expect([...plan.frame.sectionIdMap]).toEqual([
      ['section-s', 'existing-s'],
      ['section-o', 'existing-o'],
    ]);
  });

  it('構造が違えば再利用せず、場所の読み替えも作らない', () => {
    const other: Frame = {
      ...frame,
      id: 'other-frame',
      sections: [frame.sections[0]!],
    };
    const plan = planBundleReuse(bundleOf(frame, [format]), [other], [{ ...format, joiner: '\n' }]);

    expect(plan.frame.existing).toBeNull();
    expect(plan.frame.sectionIdMap.size).toBe(0);
    expect(plan.formats[0]!.existing).toBeNull();
  });
});
