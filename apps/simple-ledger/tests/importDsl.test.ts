import { describe, expect, it } from 'vitest';
import './setup';
import { CsvImportError, parseCsv } from '../src/domain/importCsv';
import {
  MAX_CONDITION_DEPTH,
  evaluateProfileText,
  importProfileDslSchema,
  importProfileSchema,
  parseImportDate,
  type ImportCondition,
  type ImportProfileDsl,
} from '../src/domain/importDsl';

/** テスト用の最小 DSL（2 列金額・eq 分類）。 */
const baseDsl: ImportProfileDsl = {
  dslVersion: 1,
  fileFormat: { encoding: 'utf-8', delimiter: ',', headerRowIndex: 0 },
  emptyValues: ['-'],
  columns: {
    date: { column: '日付', format: 'YYYY/MM/DD' },
    amount: { mode: 'in-out', outflowColumn: '出金', inflowColumn: '入金' },
    description: { columns: ['内容', '相手'], separator: ' ' },
    counterparty: { column: '相手' },
  },
  kindRules: [
    { when: { op: 'eq', column: '内容', value: '支払い' }, kind: '支払い' },
    { when: { op: 'eq', column: '内容', value: '入金' }, kind: '入金' },
  ],
};

const header = '日付,出金,入金,内容,相手';

describe('importProfileDslSchema（未知キー拒否 = ドクトリン例外）', () => {
  it('正しい DSL を受理する', () => {
    expect(importProfileDslSchema.safeParse(baseDsl).success).toBe(true);
  });

  it('トップレベルの未知キーを拒否する', () => {
    const r = importProfileDslSchema.safeParse({ ...baseDsl, regexRules: [] });
    expect(r.success).toBe(false);
  });

  it('入れ子（fileFormat）の未知キーを拒否する', () => {
    const r = importProfileDslSchema.safeParse({
      ...baseDsl,
      fileFormat: { ...baseDsl.fileFormat, skipEmpty: true },
    });
    expect(r.success).toBe(false);
  });

  it('条件式の未知キー・未知演算子（regex）を拒否する', () => {
    const withUnknownKey = {
      ...baseDsl,
      kindRules: [{ when: { op: 'eq', column: '内容', value: 'x', flags: 'i' }, kind: 'x' }],
    };
    expect(importProfileDslSchema.safeParse(withUnknownKey).success).toBe(false);
    const withRegex = {
      ...baseDsl,
      kindRules: [{ when: { op: 'regex', column: '内容', value: '.*' }, kind: 'x' }],
    };
    expect(importProfileDslSchema.safeParse(withRegex).success).toBe(false);
  });

  it('dslVersion は 1 のみ受理する', () => {
    expect(importProfileDslSchema.safeParse({ ...baseDsl, dslVersion: 2 }).success).toBe(false);
  });

  it('条件式の入れ子が最大深さを超えると拒否する', () => {
    let cond: ImportCondition = { op: 'eq', column: '内容', value: 'x' };
    for (let i = 0; i < MAX_CONDITION_DEPTH; i += 1) cond = { op: 'not', condition: cond };
    const r = importProfileDslSchema.safeParse({
      ...baseDsl,
      kindRules: [{ when: cond, kind: 'x' }],
    });
    expect(r.success).toBe(false);
  });

  it('条件ノード総数が上限を超えると拒否する', () => {
    const leaf: ImportCondition = { op: 'eq', column: '内容', value: 'x' };
    const big: ImportCondition = { op: 'or', conditions: Array(32).fill(leaf) };
    const rules = Array.from({ length: 8 }, (_, i) => ({ when: big, kind: `k${i}` }));
    const r = importProfileDslSchema.safeParse({ ...baseDsl, kindRules: rules });
    expect(r.success).toBe(false);
  });

  it('profile 封筒は strip（未知キーを黙って落とす）・dsl の中だけ strict', () => {
    const profile = {
      id: 'p1',
      name: 'テスト',
      dsl: baseDsl,
      createdAt: 'x',
      updatedAt: 'x',
      legacyField: '残骸',
    };
    const parsed = importProfileSchema.safeParse(profile);
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'legacyField' in parsed.data).toBe(false);
  });
});

describe('parseImportDate', () => {
  it('限定トークンでパースし、日時は日付へ切り捨てる', () => {
    expect(parseImportDate('2026/08/10', 'YYYY/MM/DD')).toBe('2026-08-10');
    expect(parseImportDate('2026/8/9', 'YYYY/M/D')).toBe('2026-08-09');
    expect(parseImportDate('20260810', 'YYYYMMDD')).toBe('2026-08-10');
    expect(parseImportDate('2026/08/10 08:04:52', 'YYYY/MM/DD HH:MM:SS')).toBe('2026-08-10');
  });

  it('書式違い・暦に無い日付は失敗する', () => {
    expect(parseImportDate('2026-08-10', 'YYYY/MM/DD')).toBeUndefined();
    expect(parseImportDate('2026/02/30', 'YYYY/MM/DD')).toBeUndefined();
    expect(parseImportDate('2026/08/10', 'YYYY/MM/DD HH:MM:SS')).toBeUndefined();
  });
});

describe('evaluateProfile（保存則: 全行 = normalized + skip + error）', () => {
  it('通常行を正規化する（ownSide は出金=credit / 入金=debit）', () => {
    const text = `${header}\n2026/08/01,"1,400",-,支払い,店A\n2026/08/02,-,500,入金,店B`;
    const r = evaluateProfileText(baseDsl, text);
    expect(r.errors).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.normalized).toHaveLength(2);
    const [pay, income] = r.normalized;
    expect(pay).toMatchObject({
      date: '2026-08-01',
      amount: 1400,
      kind: '支払い',
      ownSide: 'credit',
      counterparty: '店A',
      description: '支払い 店A',
    });
    expect(income).toMatchObject({ amount: 500, ownSide: 'debit', kind: '入金' });
    expect(r.totalRowCount).toBe(2);
  });

  it('全行が normalized + skipped + errors に勘定される（未知kind・日付/金額不正・both/neither・空行）', () => {
    const rows = [
      header,
      '2026/08/01,100,-,支払い,店A', // normalized
      '2026/08/02,100,-,謎の行,店B', // 未知 kind = error
      '2026/13/40,100,-,支払い,店C', // 日付不正 = error
      '2026/08/03,abc,-,支払い,店D', // 金額不正 = error
      '2026/08/04,100,200,支払い,店E', // both = error
      '2026/08/05,-,-,支払い,店F', // neither = error
      '2026/08/06,0,-,支払い,店G', // 0 円 = error
      '', // 空行 = skip
      '2026/08/07,100,-,支払い', // 列数不一致 = error
    ];
    const r = evaluateProfileText(baseDsl, rows.join('\n'));
    expect(r.normalized).toHaveLength(1);
    expect(r.skipped.map((s) => s.reasonCode)).toEqual(['blank-line']);
    expect(r.errors.map((e) => e.reasonCode)).toEqual([
      'unknown-kind',
      'date-parse-failed',
      'amount-parse-failed',
      'amount-both',
      'amount-neither',
      'amount-not-positive',
      'column-count-mismatch',
    ]);
    expect(r.totalRowCount).toBe(9);
    expect(r.normalized.length + r.skipped.length + r.errors.length).toBe(r.totalRowCount);
  });

  it('skipRules は明示 skip として理由コード付きで勘定される', () => {
    const dsl: ImportProfileDsl = {
      ...baseDsl,
      skipRules: [{ when: { op: 'prefix', column: '相手', value: '無視' }, reason: 'テスト除外' }],
    };
    const text = `${header}\n2026/08/01,100,-,支払い,無視する店`;
    const r = evaluateProfileText(dsl, text);
    expect(r.normalized).toHaveLength(0);
    expect(r.skipped).toEqual([{ rowIndex: 2, reasonCode: 'rule:テスト除外' }]);
  });

  it('ヘッダーより前の前置き行は before-header で明示 skip される', () => {
    const dsl: ImportProfileDsl = {
      ...baseDsl,
      fileFormat: { ...baseDsl.fileFormat, headerRowIndex: 1 },
    };
    const text = `メモ: 前置き\n${header}\n2026/08/01,100,-,支払い,店A`;
    const r = evaluateProfileText(dsl, text);
    expect(r.skipped).toEqual([{ rowIndex: 1, reasonCode: 'before-header' }]);
    expect(r.normalized).toHaveLength(1);
    expect(r.totalRowCount).toBe(2);
  });

  it('and / or / not / contains / suffix を評価する', () => {
    const dsl: ImportProfileDsl = {
      ...baseDsl,
      kindRules: [
        {
          when: {
            op: 'and',
            conditions: [
              { op: 'contains', column: '内容', value: '払' },
              { op: 'not', condition: { op: 'suffix', column: '相手', value: 'B' } },
            ],
          },
          kind: '対象',
        },
      ],
    };
    const text = `${header}\n2026/08/01,100,-,支払い,店A\n2026/08/02,100,-,支払い,店B`;
    const r = evaluateProfileText(dsl, text);
    expect(r.normalized.map((n) => n.kind)).toEqual(['対象']);
    expect(r.errors.map((e) => e.reasonCode)).toEqual(['unknown-kind']);
  });

  it('signed 1 列の金額（positiveDirection）を解釈する', () => {
    const dsl: ImportProfileDsl = {
      ...baseDsl,
      columns: {
        ...baseDsl.columns,
        amount: { mode: 'signed', column: '出金', positiveDirection: 'outflow' },
      },
    };
    const text = `${header}\n2026/08/01,"1,200",,支払い,店A\n2026/08/02,-300,,支払い,店B\n2026/08/03,0,,支払い,店C`;
    const r = evaluateProfileText(dsl, text);
    expect(r.normalized.map((n) => [n.amount, n.ownSide])).toEqual([
      [1200, 'credit'],
      [300, 'debit'],
    ]);
    expect(r.errors.map((e) => e.reasonCode)).toEqual(['amount-not-positive']);
  });

  it('externalId 定義があれば tuple を保持し、全列空は error', () => {
    const dsl: ImportProfileDsl = { ...baseDsl, externalId: { columns: ['相手', '内容'] } };
    const text = `${header}\n2026/08/01,100,-,支払い,店A\n2026/08/02,100,-, , `;
    const r = evaluateProfileText(dsl, text);
    expect(r.normalized[0]!.externalIdTuple).toEqual(['店A', '支払い']);
    // 2 行目は kind 不一致が先に立つ（内容=' '）ため unknown-kind。
    expect(r.errors.map((e) => e.reasonCode)).toEqual(['unknown-kind']);
  });

  it('externalId のファイル内衝突は該当する全行が external-id-duplicate の error になる', () => {
    // 同一タプルが複数行 → 決定的照合が成立しない = 評価段階で error に倒す（保存則に出す）。
    // どちらか片方に寄せない（全行 error）・衝突しない行は普通に normalized のまま。
    const dsl: ImportProfileDsl = { ...baseDsl, externalId: { columns: ['相手'] } };
    const text = [
      header,
      '2026/08/01,100,-,支払い,重複ID',
      '2026/08/02,200,-,支払い,一意ID',
      '2026/08/03,300,-,支払い,重複ID',
    ].join('\n');
    const r = evaluateProfileText(dsl, text);
    expect(r.normalized.map((n) => n.externalIdTuple)).toEqual([['一意ID']]);
    expect(r.errors).toEqual([
      { rowIndex: 2, reasonCode: 'external-id-duplicate', detail: '重複ID' },
      { rowIndex: 4, reasonCode: 'external-id-duplicate', detail: '重複ID' },
    ]);
    // 保存則: 総行数 = normalized + skipped + errors は衝突後も崩れない。
    expect(r.normalized.length + r.skipped.length + r.errors.length).toBe(r.totalRowCount);
  });

  it('externalId 衝突の error は他の error と行順で並ぶ', () => {
    const dsl: ImportProfileDsl = { ...baseDsl, externalId: { columns: ['相手'] } };
    const text = [
      header,
      '2026/08/01,100,-,支払い,重複ID',
      '2026/08/02,abc,-,支払い,別の店', // 金額不正（衝突より前の行番号ではない）
      '2026/08/03,300,-,支払い,重複ID',
    ].join('\n');
    const r = evaluateProfileText(dsl, text);
    expect(r.errors.map((e) => [e.rowIndex, e.reasonCode])).toEqual([
      [2, 'external-id-duplicate'],
      [3, 'amount-parse-failed'],
      [4, 'external-id-duplicate'],
    ]);
  });

  it('externalId が全列空の行は external-id-empty で error になる', () => {
    const dsl: ImportProfileDsl = {
      ...baseDsl,
      externalId: { columns: ['相手'] },
    };
    const text = `${header}\n2026/08/01,100,-,支払い,`;
    const r = evaluateProfileText(dsl, text);
    expect(r.errors.map((e) => e.reasonCode)).toEqual(['external-id-empty']);
  });

  it('参照列がヘッダーに無ければファイル単位で fail-closed', () => {
    const text = '日付,出金,入金,内容\n2026/08/01,100,-,支払い';
    try {
      evaluateProfileText(baseDsl, text);
      expect.unreachable();
    } catch (e) {
      expect((e as CsvImportError).code).toBe('csv-column-missing');
      expect((e as CsvImportError).params?.column).toBe('相手');
    }
  });

  it('split(",") では壊れる引用内カンマ・引用内改行の行を正しく評価する', () => {
    const text = `${header}\n2026/08/01,"1,400",-,支払い,"店,A\n二行目"`;
    const records = parseCsv(text);
    expect(records).toHaveLength(2);
    const r = evaluateProfileText(baseDsl, text);
    expect(r.normalized).toHaveLength(1);
    expect(r.normalized[0]!.counterparty).toBe('店,A\n二行目');
  });
});
