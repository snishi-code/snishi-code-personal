/*
 * 合成エンジン（domain/template.ts）のテスト。
 *
 * 最重要は golden test: 作者の実運用例文（回診メモ）を 1 文字違わず再現することを固定する。
 * 合成仕様（空伝播・keepWhenEmpty・oncall 除外・正規化の fail-safe）もここで固定する。
 */

import { describe, expect, it } from 'vitest';
import {
  buildDailyReportPreset,
  buildRoundPreset,
  composeDocument,
  composeGroup,
  composeItem,
  composePresetClean,
  composeProblems,
  composeSection,
  normalizeComposedText,
  normalizeGroup,
  normalizeItem,
  normalizeSection,
  normalizeTemplate,
  type Template,
  type TemplateGroup,
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

function group(partial: Partial<TemplateGroup> & Pick<TemplateGroup, 'id'>): TemplateGroup {
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
  return { title: '', keepWhenEmpty: false, freeText: true, groups: [], ...partial };
}

function template(partial: Partial<Template>): Template {
  return {
    id: 'tpl-test',
    name: 'テスト',
    includeProblems: false,
    includeHandover: false,
    memoSectionId: null,
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
    visitMemo: '',
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
 *  memoSection = (O)。(S)(A)(P) は正常文を持ち、定型清書 (composePresetClean) で埋まる。 */
function goldenTemplate(): Template {
  return template({
    includeProblems: true,
    includeHandover: true,
    memoSectionId: 'sec-o',
    sections: [
      section({
        id: 'sec-s',
        title: '(S)',
        keepWhenEmpty: true,
        freeText: true,
        normal: '変わりない',
      }),
      section({
        id: 'sec-o',
        title: '(O)',
        keepWhenEmpty: true,
        freeText: true,
        groups: [
          group({
            id: 'grp-vital',
            name: 'バイタル',
            display: 'always',
            joiner: ', ',
            labelSep: ' ',
            titleWrap: '',
            items: [
              item({ id: 'itm-bp', label: 'BP', kind: 'fraction', unit: 'mmHg' }),
              item({ id: 'itm-hr', label: 'HR', kind: 'number' }),
            ],
          }),
          group({
            id: 'grp-glu',
            name: '血糖',
            display: 'always',
            joiner: '-',
            labelSep: ' ',
            titleWrap: '',
            items: [
              item({ id: 'itm-glu1', label: 'Glu', kind: 'number' }),
              item({ id: 'itm-glu2', label: '', kind: 'number' }),
              item({ id: 'itm-glu3', label: '', kind: 'number' }),
            ],
          }),
          group({
            id: 'grp-phys',
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
        keepWhenEmpty: true,
        freeText: true,
        normal: '著変なし',
      }),
      section({
        id: 'sec-p',
        title: '(P)',
        keepWhenEmpty: true,
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
    // (S)(A)(P) の本文は正常文 (定型清書で充填)。memoSection (O) の今回メモは空。
    visitMemo: '',
    projectedValues: {
      'grp-vital': { 'itm-bp': { value: '120/98' }, 'itm-hr': { value: '63' } },
      'grp-glu': {
        'itm-glu1': { value: '108' },
        'itm-glu2': { value: '222' },
        'itm-glu3': { value: '100' },
      },
      'grp-phys': {
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

  it('includeHandover=false なら申し送りブロックが落ちる', () => {
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

  it('composeDocument は今回メモを memoSection (O) の自由本文として注入する', () => {
    const p = { ...goldenPatient(), visitMemo: '右下肺に湿性ラ音' };
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

  it('number: 値なしで注記だけなら出力しない', () => {
    const it_ = item({ id: 'i', label: 'SpO2', kind: 'number', unit: '%' });
    expect(composeItem(it_, { value: '', note: 'O2 2L' }, sep)).toBe('');
  });

  it('number: 値+単位の直後に注記が付く', () => {
    const it_ = item({ id: 'i', label: 'SpO2', kind: 'number', unit: '%' });
    expect(composeItem(it_, { value: '96', note: 'O2 2L' }, sep)).toBe('SpO2 96% O2 2L');
  });

  it("fraction: '' や '/' だけはスキップ", () => {
    const it_ = item({ id: 'i', label: 'BP', kind: 'fraction', unit: 'mmHg' });
    expect(composeItem(it_, { value: '' }, sep)).toBe('');
    expect(composeItem(it_, { value: '/' }, sep)).toBe('');
    expect(composeItem(it_, { value: '120/98' }, sep)).toBe('BP 120/98mmHg');
  });

  it('showLabel=false ならラベルを省略して値だけを出す', () => {
    const it_ = item({ id: 'i', label: 'Glu', kind: 'number', showLabel: false });
    expect(composeItem(it_, { value: '108' }, sep)).toBe('108');
  });

  it('label が空文字ならラベル部そのものが付かない（labelSep も出ない）', () => {
    const it_ = item({ id: 'i', label: '', kind: 'number' });
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
// composeGroup / composeSection（空伝播）
// ============================

describe('composeGroup', () => {
  const g = group({
    id: 'g',
    name: 'バイタル',
    titleWrap: '（）',
    joiner: ', ',
    labelSep: ' ',
    items: [
      item({ id: 'a', label: 'BP', kind: 'fraction' }),
      item({ id: 'b', label: 'HR', kind: 'number' }),
    ],
  });

  it('全項目が空ならタイトル行ごと消える（hasValue=false）', () => {
    expect(composeGroup(g, { a: { value: '/' }, b: '' })).toEqual({ text: '', hasValue: false });
  });

  it('titleWrap があれば群名を囲んだタイトル行が付く', () => {
    expect(composeGroup(g, { b: { value: '63' } })).toEqual({
      text: '（バイタル）\nHR 63',
      hasValue: true,
    });
  });

  it('titleWrap が空ならタイトル行なしで本文だけ', () => {
    const g2 = { ...g, titleWrap: '' };
    expect(composeGroup(g2, { a: { value: '120/80' }, b: { value: '63' } }).text).toBe(
      'BP 120/80, HR 63',
    );
  });

  it('titleWrap があっても name が空ならタイトル行は出ない', () => {
    const g2 = { ...g, name: '' };
    expect(composeGroup(g2, { b: { value: '63' } }).text).toBe('HR 63');
  });
});

describe('composeSection', () => {
  const oGroups = [
    group({
      id: 'g1',
      name: 'バイタル',
      joiner: ', ',
      labelSep: ' ',
      items: [item({ id: 'a', label: 'HR', kind: 'number' })],
    }),
    group({
      id: 'g2',
      name: '血糖',
      display: 'oncall',
      joiner: '-',
      labelSep: ' ',
      items: [item({ id: 'b', label: 'Glu', kind: 'number' })],
    }),
  ];

  it('値が全部空の group はタイトル行ごと消え、自由本文だけ残る', () => {
    const sec = section({ id: 's', title: '(O)', keepWhenEmpty: true, groups: oGroups });
    expect(composeSection(sec, '所見メモ', { g1: { a: '' } })).toBe('(O)\n所見メモ');
  });

  it('空 section は keepWhenEmpty=false なら丸ごと消える', () => {
    const sec = section({ id: 's', title: '(O)', keepWhenEmpty: false, groups: oGroups });
    expect(composeSection(sec, '', {})).toBe('');
  });

  it('空 section は keepWhenEmpty=true なら見出しのみ残る', () => {
    const sec = section({ id: 's', title: '(S)', keepWhenEmpty: true });
    expect(composeSection(sec, '', {})).toBe('(S)');
  });

  it('keepWhenEmpty=true でも title が空なら何も出さない', () => {
    const sec = section({ id: 's', title: '', keepWhenEmpty: true });
    expect(composeSection(sec, '', {})).toBe('');
  });

  it('oncall 群も値があれば所属セクションへ合成する', () => {
    const sec = section({ id: 's', title: '(O)', keepWhenEmpty: true, groups: oGroups });
    const out = composeSection(sec, '', {
      g1: { a: { value: '63' } },
      g2: { b: { value: '108' } },
    });
    expect(out).toBe('(O)\nHR 63\n\nGlu 108');
  });

  it('freeText=false なら自由本文が入っていても無視する', () => {
    const sec = section({ id: 's', title: '(O)', freeText: false, groups: oGroups });
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
    memoSectionId: 's1',
    sections: [
      section({ id: 's1', title: '(S)', keepWhenEmpty: true, normal: '変わりない' }),
      section({ id: 's2', title: '(A)', keepWhenEmpty: true, normal: '著変なし' }),
      section({ id: 's3', title: '(P)', keepWhenEmpty: true }), // normal なし
    ],
  });

  it('空の freeText セクションだけ normal で埋まり、今回メモ入力済みは上書きしない', () => {
    const sub = patient({ visitMemo: '食欲低下あり' });
    expect(composePresetClean(sub, tpl)).toBe('(S)\n食欲低下あり\n\n(A)\n著変なし\n\n(P)');
  });

  it('normal のないセクションは埋まらず keepWhenEmpty に従う', () => {
    const sub = patient({});
    expect(composePresetClean(sub, tpl)).toBe('(S)\n変わりない\n\n(A)\n著変なし\n\n(P)');
  });

  it('freeText=false のセクションは normal があっても埋めない', () => {
    const tpl2 = template({
      sections: [
        section({ id: 's1', title: '(S)', keepWhenEmpty: true, freeText: false, normal: 'x' }),
      ],
    });
    expect(composePresetClean(patient({}), tpl2)).toBe('(S)');
  });

  it('patient は不変（visitMemo / projectedValues を書き換えない）', () => {
    const sub = patient({ visitMemo: '', projectedValues: {} });
    composePresetClean(sub, tpl);
    expect(sub.visitMemo).toBe('');
    expect(sub.projectedValues).toEqual({});
  });
});

// ============================
// normalize*（fail-safe 正規化）
// ============================

describe('normalizeItem', () => {
  it('text で label も normal も無い壊れ row は捨てる', () => {
    expect(normalizeItem({ kind: 'text', label: '' })).toBeNull();
  });

  it('number/fraction はラベル無しでも生かす（血糖 2 つ目以降の形）', () => {
    expect(normalizeItem({ kind: 'number', label: '' })).toMatchObject({
      kind: 'number',
      label: '',
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
    const r = normalizeItem({ kind: 'number', label: 'HR' });
    expect(r?.id).toMatch(/^itm_/);
  });

  it('不正な kind は text に落とす', () => {
    expect(normalizeItem({ kind: 'bogus', label: '肺音' })?.kind).toBe('text');
  });

  it('showLabel は false のときだけ持つ・空 unit/normal は持たない', () => {
    const r = normalizeItem({ kind: 'number', label: 'HR', showLabel: true, unit: '', normal: '' });
    expect(r).toEqual({ id: r?.id, label: 'HR', kind: 'number' });
  });

  it('object でないものは null', () => {
    expect(normalizeItem(null)).toBeNull();
    expect(normalizeItem('x')).toBeNull();
  });
});

describe('normalizeGroup', () => {
  it('items が全滅した group は捨てる', () => {
    expect(normalizeGroup({ name: 'g', items: [{ kind: 'text', label: '' }] })).toBeNull();
    expect(normalizeGroup({ name: 'g', items: [] })).toBeNull();
  });

  it('id 採番と区切り既定値（joiner=改行・labelSep=：）', () => {
    const r = normalizeGroup({ name: 'g', items: [{ kind: 'number', label: 'HR' }] });
    expect(r?.id).toMatch(/^grp_/);
    expect(r?.joiner).toBe('\n');
    expect(r?.labelSep).toBe('：');
    expect(r?.display).toBe('always');
  });

  it('joiner/labelSep は空文字列も有効な設定として保持する', () => {
    const r = normalizeGroup({
      name: 'g',
      joiner: '',
      labelSep: '',
      items: [{ kind: 'number', label: 'HR' }],
    });
    expect(r?.joiner).toBe('');
    expect(r?.labelSep).toBe('');
  });
});

describe('normalizeSection', () => {
  it('title も freeText も groups も無い空 section は捨てる', () => {
    expect(normalizeSection({ title: '', freeText: false, groups: [] })).toBeNull();
  });

  it('freeText は未指定なら true（自由本文が既定）', () => {
    const r = normalizeSection({ title: '' });
    expect(r?.freeText).toBe(true);
    expect(r?.keepWhenEmpty).toBe(false);
  });

  it('壊れ group を落としても section 自体は生きる', () => {
    const r = normalizeSection({ title: '(O)', groups: [null, { items: [] }] });
    expect(r?.groups).toEqual([]);
  });
});

describe('normalizeTemplate', () => {
  it('sections が全滅した壊れテンプレは null', () => {
    expect(
      normalizeTemplate({ sections: [{ title: '', freeText: false, groups: [] }] }),
    ).toBeNull();
    expect(normalizeTemplate({ sections: [] })).toBeNull();
    expect(normalizeTemplate(null)).toBeNull();
    expect(normalizeTemplate('x')).toBeNull();
  });

  it('id/name/updatedAt の欠落は既定値で救う', () => {
    const r = normalizeTemplate({ sections: [{ title: '(S)' }] });
    expect(r?.id).toMatch(/^tpl_/);
    expect(r?.name).toBe('(無題テンプレート)');
    expect(r?.updatedAt).toBe(0);
    // includeProblems/includeHandover は明示 true 以外 false
    expect(r?.includeProblems).toBe(false);
    expect(r?.includeHandover).toBe(false);
  });

  it('プリセット 2 種は normalizeTemplate をそのまま通る（seed の健全性）', () => {
    const round = buildRoundPreset(1000);
    const daily = buildDailyReportPreset(1000);
    expect(normalizeTemplate(round)).toEqual(round);
    expect(normalizeTemplate(daily)).toEqual(daily);
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
