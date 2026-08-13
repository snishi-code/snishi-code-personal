import { describe, expect, it } from 'vitest';
import type { Format, Frame, TemplateDef } from './entities';
import { buildRoundPreset } from './presets';
import { resolveTemplate } from './resolveTemplate';
import { composePresetClean } from './template';
import type { Patient } from './types';

const frame: Frame = {
  id: 'frame-soap',
  name: 'SOAP',
  sections: [
    { id: 'section-s', title: '(S)', freeText: true, normal: '変わりない' },
    { id: 'section-o', title: '(O)', freeText: true },
  ],
};

const format: Format = {
  id: 'format-vitals',
  name: 'バイタル',
  joiner: ', ',
  labelSep: ' ',
  titleWrap: '',
  items: [{ id: 'item-bp', label: 'BP', kind: 'text', unit: 'mmHg' }],
};

function definition(overrides: Partial<TemplateDef> = {}): TemplateDef {
  return {
    id: 'template-round',
    name: '回診',
    frameId: frame.id,
    includeProblems: true,
    includeHandover: true,
    placements: [
      {
        id: 'placement-first',
        sectionId: 'section-o',
        formatId: format.id,
        display: 'always',
      },
      {
        id: 'placement-second',
        sectionId: 'section-s',
        formatId: format.id,
        display: 'menu',
      },
    ],
    updatedAt: 100,
    ...overrides,
  };
}

describe('resolveTemplate', () => {
  it('フレームとフォーマットを配置順に解決し、display を配置から合成する', () => {
    const resolved = resolveTemplate(definition(), [frame], [format]);
    expect(resolved?.sections[0]?.formats[0]).toMatchObject({
      id: 'placement-second',
      name: 'バイタル',
      display: 'menu',
    });
    expect(resolved?.sections[1]?.formats[0]).toMatchObject({
      id: 'placement-first',
      name: 'バイタル',
      display: 'always',
    });
  });

  it('同一フォーマットの複数配置でも解決済み id は別の配置 ID になる', () => {
    const resolved = resolveTemplate(definition(), [frame], [format]);
    const ids = resolved?.sections.flatMap((section) => section.formats.map((placed) => placed.id));
    expect(ids).toEqual(['placement-second', 'placement-first']);
    expect(new Set(ids).size).toBe(2);
  });

  it('迷子配置は落とす（迷子の場所・迷子のフォーマットとも）', () => {
    const resolved = resolveTemplate(
      definition({
        placements: [
          {
            id: 'missing-section-placement',
            sectionId: 'missing-section',
            formatId: format.id,
            display: 'always',
          },
          {
            id: 'missing-format-placement',
            sectionId: 'section-o',
            formatId: 'missing-format',
            display: 'always',
          },
        ],
      }),
      [frame],
      [format],
    );
    expect(resolved?.sections.every((section) => section.formats.length === 0)).toBe(true);
  });

  it('迷子フレームはテンプレートごと null にする', () => {
    expect(resolveTemplate(definition({ frameId: 'missing-frame' }), [frame], [format])).toBeNull();
  });

  it('新 seed の解決結果は作者の回診プリセット本文を完全再現する', () => {
    const preset = buildRoundPreset(100);
    const resolved = resolveTemplate(preset.template, [preset.frame], preset.formats)!;
    const placed = (name: string) =>
      resolved.sections.flatMap((section) => section.formats).find((entry) => entry.name === name)!;
    const itemId = (formatName: string, label: string, offset = 0) => {
      const matches = placed(formatName).items.filter((item) => item.label === label);
      return matches[offset]!.id;
    };
    const vitals = placed('バイタル');
    const physical = placed('身体所見');
    const glucose = placed('血糖');
    const patient: Patient = {
      pid: 'patient-golden',
      name: '',
      room: '',
      placeId: '',
      status: 'none',
      tags: [],
      problems: ['HF', 'DM', '誤嚥性肺炎\n　7/20- TAZ/PIPC 9g/2'],
      sectionTexts: {},
      standingMemo: '週明けLabo\n家族IC希望あり',
      projectedValues: {
        [vitals.id]: {
          [itemId('バイタル', 'BP')]: { value: '120/98' },
          [itemId('バイタル', 'HR')]: { value: '63' },
        },
        [glucose.id]: {
          [itemId('血糖', 'Glu')]: { value: '108' },
          [itemId('血糖', '', 0)]: { value: '222' },
          [itemId('血糖', '', 1)]: { value: '100' },
        },
        [physical.id]: Object.fromEntries(
          physical.items.map((item) => [item.id, { value: item.normal, source: 'preset' }]),
        ),
      },
      updatedAt: 0,
      archivedAt: null,
    };
    const expected =
      '#1 HF\n#2 DM\n#3 誤嚥性肺炎\n　7/20- TAZ/PIPC 9g/2\n\n週明けLabo\n家族IC希望あり\n\n(S)\n変わりない\n\n(O)\nBP 120/98mmHg, HR 63\n\n肺音：明らかなラ音なし\n腸音：正常\n腹部：平坦軟、圧痛なし\n下腿浮腫：なし\n\nGlu 108-222-100\n\n(A)\n著変なし\n\n(P)\n現行加療継続';
    expect(composePresetClean(patient, resolved)).toBe(expected);
  });

  it('seed の配置 display を固定する（合成テストでは検知できない回帰網）', () => {
    const preset = buildRoundPreset(100);
    const nameOf = new Map(preset.formats.map((format) => [format.id, format.name]));
    expect(
      preset.template.placements.map((placement) => [
        nameOf.get(placement.formatId),
        placement.display,
      ]),
    ).toEqual([
      ['バイタル', 'always'],
      ['身体所見', 'always'],
      ['血糖', 'oncall'],
      ['検査所見', 'oncall'],
    ]);
  });
});
