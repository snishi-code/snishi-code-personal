/*
 * 合成エンジン（domain/template.ts）のテスト。
 *
 * 最重要は golden test: 作者の実運用例文（回診メモ）を 1 文字違わず再現することを固定する。
 * 合成仕様（空伝播・場所見出しの常時保持・正規化の fail-safe）もここで固定する。
 */

import { describe, expect, it } from 'vitest';
import {
  composeDocument,
  composePlacedFormat,
  composeItem,
  composePresetClean,
  composeProblems,
  composeSection,
  normalizeComposedText,
  normalizeItem,
  type Template,
  type PlacedFormat,
  type TemplateItem,
  type TemplateSection,
} from './template';
import type { Patient } from './types';

// ============================
// テスト用ビルダー（固定 id で組む。newId 依存を避け golden を安定させる）
// ============================

function item(partial: Partial<TemplateItem> & Pick<TemplateItem, 'id'>): TemplateItem {
  return { label: '', kind: 'text', ...partial };
}

function placedFormat(partial: Partial<PlacedFormat> & Pick<PlacedFormat, 'id'>): PlacedFormat {
  return {
    name: '',
    display: 'always',
    joiner: '\n',
    labelSep: '：',
    titleWrap: '',
    items: [],
    ...partial,
  };
}

function section(partial: Partial<TemplateSection> & Pick<TemplateSection, 'id'>): TemplateSection {
  return { title: '', freeText: true, formats: [], ...partial };
}

function template(partial: Partial<Template>): Template {
  return {
    id: 'tpl-test',
    name: 'テスト',
    includeProblems: false,
    includeHandover: false,
    sections: [],
    updatedAt: 0,
    ...partial,
  };
}

function patient(partial: Partial<Patient>): Patient {
  return {
    pid: 'pat-test',
    status: 'none',
    name: '',
    room: '',
    placeId: '',
    tags: [],
    problems: [],
    sectionTexts: {},
    templateId: '',
    standingMemo: '',
    projectedValues: {},
    updatedAt: 0,
    archivedAt: null,
    ...partial,
  };
}

// ============================
// golden test: 作者の実運用例文
// ============================

/** 回診メモ相当のテンプレート（golden 用。血糖も always にして 3 群とも出力する）。
 *  自由本文は各場所が持つ。(S)(A)(P) は正常文を持ち、定型清書 (composePresetClean) で埋まる。 */
function goldenTemplate(): Template {
  return template({
    includeProblems: true,
    includeHandover: true,
    sections: [
      section({
        id: 'sec-s',
        title: '(S)',
        freeText: true,
        normal: '変わりない',
      }),
      section({
        id: 'sec-o',
        title: '(O)',
        freeText: true,
        formats: [
          placedFormat({
            id: 'plm-vital',
            name: 'バイタル',
            display: 'always',
            joiner: ', ',
            labelSep: ' ',
            titleWrap: '',
            items: [
              item({ id: 'itm-bp', label: 'BP', kind: 'text', unit: 'mmHg' }),
              item({ id: 'itm-hr', label: 'HR', kind: 'text' }),
            ],
          }),
          placedFormat({
            id: 'plm-glu',
            name: '血糖',
            display: 'always',
            joiner: '-',
            labelSep: ' ',
            titleWrap: '',
            items: [
              item({ id: 'itm-glu1', label: 'Glu', kind: 'text' }),
              item({ id: 'itm-glu2', label: '', kind: 'text' }),
              item({ id: 'itm-glu3', label: '', kind: 'text' }),
            ],
          }),
          placedFormat({
            id: 'plm-phys',
            name: '身体所見',
            display: 'always',
            joiner: '\n',
            labelSep: '：',
            titleWrap: '',
            items: [
              item({ id: 'itm-lung', label: '肺音', kind: 'text', normal: '明らかなラ音なし' }),
              item({ id: 'itm-bowel', label: '腸音', kind: 'text', normal: '正常' }),
              item({ id: 'itm-abd', label: '腹部', kind: 'text', normal: '平坦軟、圧痛なし' }),
              item({ id: 'itm-edema', label: '下腿浮腫', kind: 'text', normal: 'なし' }),
            ],
          }),
        ],
      }),
      section({
        id: 'sec-a',
        title: '(A)',
        freeText: true,
        normal: '著変なし',
      }),
      section({
        id: 'sec-p',
        title: '(P)',
        freeText: true,
        normal: '現行加療継続',
      }),
    ],
  });
}

function goldenPatient(): Patient {
  return patient({
    problems: ['HF', 'DM', '誤嚥性肺炎\n　7/20- TAZ/PIPC 9g/2'],
    standingMemo: '週明けLabo\n家族IC希望あり',
    // (S)(A)(P) の本文は正常文 (定型清書で充填)。(O) の自由本文は空。
    sectionTexts: {},
    projectedValues: {
      'plm-vital': { 'itm-bp': { value: '120/98' }, 'itm-hr': { value: '63' } },
      'plm-glu': {
        'itm-glu1': { value: '108' },
        'itm-glu2': { value: '222' },
        'itm-glu3': { value: '100' },
      },
      'plm-phys': {
        'itm-lung': { value: '明らかなラ音なし', source: 'preset' },
        'itm-bowel': { value: '正常', source: 'preset' },
        'itm-abd': { value: '平坦軟、圧痛なし', source: 'preset' },
        'itm-edema': { value: 'なし', source: 'preset' },
      },
    },
  });
}

describe('composePresetClean golden（作者の実運用例文）', () => {
  it('回診メモ例文を 1 文字違わず再現する', () => {
    const expected =
      '#1 HF\n#2 DM\n#3 誤嚥性肺炎\n　7/20- TAZ/PIPC 9g/2\n\n週明けLabo\n家族IC希望あり\n\n(S)\n変わりない\n\n(O)\nBP 120/98mmHg, HR 63\n\nGlu 108-222-100\n\n肺音：明らかなラ音なし\n腸音：正常\n腹部：平坦軟、圧痛なし\n下腿浮腫：なし\n\n(A)\n著変なし\n\n(P)\n現行加療継続';
    expect(composePresetClean(goldenPatient(), goldenTemplate())).toBe(expected);
  });

  it('includeProblems=false なら問題ブロックが落ち、他は変わらない', () => {
    const tpl = { ...goldenTemplate(), includeProblems: false };
    const out = composePresetClean(goldenPatient(), tpl);
    expect(out.startsWith('週明けLabo\n家族IC希望あり\n\n(S)')).toBe(true);
    expect(out).not.toContain('#1');
  });

  it('includeHandover=false なら継続メモブロックが落ちる', () => {
    const tpl = { ...goldenTemplate(), includeHandover: false };
    const out = composePresetClean(goldenPatient(), tpl);
    expect(out).not.toContain('週明けLabo');
    expect(out).toContain('#1 HF\n#2 DM');
  });

  it('standingMemo が空白のみならブロック自体を出さない（空行が増えない）', () => {
    const sub = { ...goldenPatient(), standingMemo: '  \n ' };
    const out = composePresetClean(sub, goldenTemplate());
    expect(out).toContain('　7/20- TAZ/PIPC 9g/2\n\n(S)');
  });

  it('composeDocument は (O) に書いた自由本文をその場所へ出す', () => {
    const p = { ...goldenPatient(), sectionTexts: { 'sec-o': '右下肺に湿性ラ音' } };
    const out = composeDocument(p, goldenTemplate());
    // (O) は群の後に自由本文。 (S)(A)(P) は normal を充填しない (見出しのみ)。
    expect(out).toContain('下腿浮腫：なし\n\n右下肺に湿性ラ音\n\n(A)');
    expect(out).toContain('(S)\n\n(O)');
    expect(out).toContain('(A)\n\n(P)');
  });
});

// ============================
// composeItem
// ============================

describe('composeItem', () => {
  const sep = ' ';

  it('単位は値の直後に付く', () => {
    const it_ = item({ id: 'i', label: 'SpO2', kind: 'text', unit: '%' });
    expect(composeItem(it_, { value: '96', source: 'manual' }, sep)).toBe('SpO2 96%');
  });

  it('旧 number/fraction の保存形（source なし）をそのまま読む', () => {
    // 種類を text へ畳んだ後も、端末内の既存値・取り込み JSON の値が消えない。
    const it_ = item({ id: 'i', label: 'BP', kind: 'text', unit: 'mmHg' });
    expect(composeItem(it_, { value: '' }, sep)).toBe('');
    expect(composeItem(it_, { value: '120/98' }, sep)).toBe('BP 120/98mmHg');
  });

  it('旧 note は値+単位の後ろに残る・値なし注記だけは出力しない', () => {
    const it_ = item({ id: 'i', label: 'SpO2', kind: 'text', unit: '%' });
    expect(composeItem(it_, { value: '', note: 'O2 2L' }, sep)).toBe('');
    expect(composeItem(it_, { value: '96', note: 'O2 2L' }, sep)).toBe('SpO2 96% O2 2L');
  });

  it('select は単位も注記も出さない（選択値そのものが答えなので）', () => {
    const it_ = item({ id: 'i', label: '方針', kind: 'select', options: ['精査'], unit: '%' });
    expect(composeItem(it_, { value: '精査', source: 'manual', note: 'x' }, '：')).toBe(
      '方針：精査',
    );
  });

  it('showLabel=false ならラベルを省略して値だけを出す', () => {
    const it_ = item({ id: 'i', label: 'Glu', kind: 'text', showLabel: false });
    expect(composeItem(it_, { value: '108' }, sep)).toBe('108');
  });

  it('label が空文字ならラベル部そのものが付かない（labelSep も出ない）', () => {
    const it_ = item({ id: 'i', label: '', kind: 'text' });
    expect(composeItem(it_, { value: '222' }, sep)).toBe('222');
  });

  it('text: 空値は空文字・値ありは label+labelSep+値', () => {
    const it_ = item({ id: 'i', label: '肺音', kind: 'text', normal: '明らかなラ音なし' });
    expect(composeItem(it_, '', '：')).toBe('');
    expect(composeItem(it_, { value: '明らかなラ音なし', source: 'preset' }, '：')).toBe(
      '肺音：明らかなラ音なし',
    );
  });

  it('select: text と同じ経路で選択値を合成する', () => {
    const it_ = item({
      id: 'i',
      label: '方針',
      kind: 'select',
      options: ['経過観察', '精査'],
    });
    expect(composeItem(it_, '', '：')).toBe('');
    expect(composeItem(it_, { value: '精査', source: 'manual' }, '：')).toBe('方針：精査');
  });
});

// ============================
// composePlacedFormat / composeSection（空伝播）
// ============================

describe('composePlacedFormat', () => {
  const format = placedFormat({
    id: 'placement',
    name: 'バイタル',
    titleWrap: '（）',
    joiner: ', ',
    labelSep: ' ',
    items: [
      item({ id: 'a', label: 'BP', kind: 'text' }),
      item({ id: 'b', label: 'HR', kind: 'text' }),
    ],
  });

  it('全項目が空ならタイトル行ごと消える（hasValue=false）', () => {
    expect(composePlacedFormat(format, { a: { value: '' }, b: '' })).toEqual({
      text: '',
      hasValue: false,
    });
  });

  it('titleWrap があればフォーマット名を囲んだタイトル行が付く', () => {
    expect(composePlacedFormat(format, { b: { value: '63' } })).toEqual({
      text: '（バイタル）\nHR 63',
      hasValue: true,
    });
  });

  it('titleWrap が空ならタイトル行なしで本文だけ', () => {
    const withoutTitle = { ...format, titleWrap: '' };
    expect(
      composePlacedFormat(withoutTitle, {
        a: { value: '120/80' },
        b: { value: '63' },
      }).text,
    ).toBe('BP 120/80, HR 63');
  });

  it('titleWrap があっても name が空ならタイトル行は出ない', () => {
    const withoutName = { ...format, name: '' };
    expect(composePlacedFormat(withoutName, { b: { value: '63' } }).text).toBe('HR 63');
  });

  it('項目を並び替えても安定 id で対応する値を読む', () => {
    const reordered = {
      ...format,
      items: [format.items[1]!, format.items[0]!],
    };
    expect(
      composePlacedFormat(reordered, { a: { value: '120/80' }, b: { value: '63' } }).text,
    ).toBe('（バイタル）\nHR 63, BP 120/80');
  });
});

describe('composeSection', () => {
  const oPlacements = [
    placedFormat({
      id: 'g1',
      name: 'バイタル',
      joiner: ', ',
      labelSep: ' ',
      items: [item({ id: 'a', label: 'HR', kind: 'text' })],
    }),
    placedFormat({
      id: 'g2',
      name: '血糖',
      display: 'oncall',
      joiner: '-',
      labelSep: ' ',
      items: [item({ id: 'b', label: 'Glu', kind: 'text' })],
    }),
  ];

  it('値が全部空の配置はタイトル行ごと消え、自由本文だけ残る', () => {
    const sec = section({ id: 's', title: '(O)', formats: oPlacements });
    expect(composeSection(sec, '所見メモ', { g1: { a: '' } })).toBe('(O)\n所見メモ');
  });

  it('空 section も見出しを常に残す', () => {
    const sec = section({ id: 's', title: '(S)' });
    expect(composeSection(sec, '', {})).toBe('(S)');
  });

  it('title が空なら空 section は何も出さない', () => {
    const sec = section({ id: 's', title: '' });
    expect(composeSection(sec, '', {})).toBe('');
  });

  it('oncall 配置も値があれば所属セクションへ合成する', () => {
    const sec = section({ id: 's', title: '(O)', formats: oPlacements });
    const out = composeSection(sec, '', {
      g1: { a: { value: '63' } },
      g2: { b: { value: '108' } },
    });
    expect(out).toBe('(O)\nHR 63\n\nGlu 108');
  });

  it('freeText=false なら自由本文が入っていても無視する', () => {
    const sec = section({ id: 's', title: '(O)', freeText: false, formats: oPlacements });
    expect(composeSection(sec, '無視されるはず', { g1: { a: { value: '63' } } })).toBe(
      '(O)\nHR 63',
    );
  });
});

// ============================
// composeProblems
// ============================

describe('composeProblems', () => {
  it('空行だけの問題はスキップし連番が詰まる', () => {
    expect(composeProblems(['HF', '', '   ', 'DM'])).toBe('#1 HF\n#2 DM');
  });

  it('継続行（2 行目以降）はそのまま続き、#n は先頭行だけに付く', () => {
    expect(composeProblems(['誤嚥性肺炎\n　7/20- TAZ/PIPC 9g/2', 'DM'])).toBe(
      '#1 誤嚥性肺炎\n　7/20- TAZ/PIPC 9g/2\n#2 DM',
    );
  });

  it('末尾の空白・改行は落とす', () => {
    expect(composeProblems(['HF\n\n  '])).toBe('#1 HF');
  });

  it('全部空なら空文字', () => {
    expect(composeProblems(['', '  '])).toBe('');
    expect(composeProblems([])).toBe('');
  });
});

// ============================
// composePresetClean（定型清書）
// ============================

describe('composePresetClean', () => {
  const tpl = template({
    sections: [
      section({ id: 's1', title: '(S)', normal: '変わりない' }),
      section({ id: 's2', title: '(A)', normal: '著変なし' }),
      section({ id: 's3', title: '(P)' }), // normal なし
    ],
  });

  it('空の freeText セクションだけ normal で埋まり、入力済みの自由本文は上書きしない', () => {
    const sub = patient({ sectionTexts: { s1: '食欲低下あり' } });
    expect(composePresetClean(sub, tpl)).toBe('(S)\n食欲低下あり\n\n(A)\n著変なし\n\n(P)');
  });

  it('normal のないセクションも見出しだけ残る', () => {
    const sub = patient({});
    expect(composePresetClean(sub, tpl)).toBe('(S)\n変わりない\n\n(A)\n著変なし\n\n(P)');
  });

  it('freeText=false のセクションは normal があっても埋めない', () => {
    const tpl2 = template({
      sections: [section({ id: 's1', title: '(S)', freeText: false, normal: 'x' })],
    });
    expect(composePresetClean(patient({}), tpl2)).toBe('(S)');
  });

  it('freeText=false の場所は sectionTexts に残存値があっても合成に混ぜない', () => {
    const tpl2 = template({
      sections: [
        section({ id: 's1', title: '(S)', freeText: false, normal: 'x' }),
        section({ id: 's2', title: '(A)' }),
      ],
    });
    const sub = patient({ sectionTexts: { s1: '残存した自由本文', s2: '生きている本文' } });
    expect(composeDocument(sub, tpl2)).toBe('(S)\n\n(A)\n生きている本文');
    expect(composePresetClean(sub, tpl2)).toBe('(S)\n\n(A)\n生きている本文');
  });

  it('patient は不変（sectionTexts / projectedValues を書き換えない）', () => {
    const sub = patient({ sectionTexts: {}, projectedValues: {} });
    composePresetClean(sub, tpl);
    expect(sub.sectionTexts).toEqual({});
    expect(sub.projectedValues).toEqual({});
  });
});

// ============================
// normalize*（fail-safe 正規化）
// ============================

describe('normalizeItem', () => {
  it('ラベル無しの text も生かす（血糖 2 つ目以降・追加直後の空項目の形）', () => {
    expect(normalizeItem({ kind: 'text', label: '' })).toMatchObject({ kind: 'text', label: '' });
  });

  it('旧 kind（number/fraction）は text へ引き取り、単位も持ち越す', () => {
    expect(normalizeItem({ kind: 'number', label: 'SpO2', unit: '%' })).toMatchObject({
      kind: 'text',
      label: 'SpO2',
      unit: '%',
    });
    expect(normalizeItem({ kind: 'fraction', label: 'BP', unit: 'mmHg' })).toMatchObject({
      kind: 'text',
      label: 'BP',
      unit: 'mmHg',
    });
  });

  it('select は空選択肢を除外し、1 件も残らなければ row を捨てる', () => {
    expect(
      normalizeItem({
        kind: 'select',
        label: '方針',
        options: [' 経過観察 ', '', '精査'],
        normal: '持たせない',
        unit: '持たせない',
      }),
    ).toMatchObject({
      kind: 'select',
      label: '方針',
      options: ['経過観察', '精査'],
    });
    expect(normalizeItem({ kind: 'select', label: '方針', options: ['', 1] })).toBeNull();
  });

  it('id 欠落は itm_ prefix で採番して救う', () => {
    const r = normalizeItem({ kind: 'text', label: 'HR' });
    expect(r?.id).toMatch(/^itm_/);
  });

  it('不正な kind は text に落とす', () => {
    expect(normalizeItem({ kind: 'bogus', label: '肺音' })?.kind).toBe('text');
  });

  it('showLabel は false のときだけ持つ・空 unit/normal は持たない', () => {
    const r = normalizeItem({ kind: 'text', label: 'HR', showLabel: true, unit: '', normal: '' });
    expect(r).toEqual({ id: r?.id, label: 'HR', kind: 'text' });
  });

  it('object でないものは null', () => {
    expect(normalizeItem(null)).toBeNull();
    expect(normalizeItem('x')).toBeNull();
  });
});

// ============================
// normalizeComposedText
// ============================

describe('normalizeComposedText', () => {
  it('3 連以上の改行を 2 つへ潰す', () => {
    expect(normalizeComposedText('a\n\n\nb\n\n\n\nc')).toBe('a\n\nb\n\nc');
  });

  it('末尾の空白・改行を落とす', () => {
    expect(normalizeComposedText('a\n\n')).toBe('a');
    expect(normalizeComposedText('a  \t\n')).toBe('a');
  });
});
