/*
 * 貼り付け一括登録のパーサ回帰（v13.10）。
 * 厳密形式（作者決定 2026-08-19 受信箱）: 1 行 = 1 仕訳・カンマ区切り・
 * 日付,摘要,金額,貸方,借方。許す寛容はセルの trim と空行スキップだけ。
 * エラーは全行ぶん行番号付きで列挙する（1 行でもあれば呼び出し側は登録しない）。
 */
import { describe, expect, it } from 'vitest';
import { parsePasteText, PASTE_MAX_ROWS } from '../src/ui/pasteImport';
import { MAX_LEDGER_DATE } from '../src/domain/calendar';
import type { Account } from '../src/domain/types';

function account(
  input: Pick<Account, 'id' | 'name' | 'type' | 'role'> & Partial<Account>,
): Account {
  return {
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...input,
  };
}

const ACCOUNTS: Account[] = [
  account({ id: 'cash', name: '現金', type: 'asset', role: 'daily-asset' }),
  account({ id: 'food', name: '食費', type: 'expense', role: 'expense-category' }),
  account({ id: 'card', name: '三井住友カード', type: 'liability', role: 'payment-liability' }),
  account({ id: 'pending', name: '未記入', type: 'expense', role: 'expense-category' }),
  account({
    id: 'ledger',
    name: '継続コスト台帳',
    type: 'asset',
    role: 'continuing-cost-asset',
  }),
  account({
    id: 'ended',
    name: '旧口座',
    type: 'asset',
    role: 'daily-asset',
    endDate: '2026-01-31',
    archived: true,
  }),
];

describe('parsePasteText 正常系', () => {
  it('複数行を順に解析する（貸方 = 4 列目・借方 = 5 列目・金額は minor 100 倍）', () => {
    const text = [
      '2026-08-19,ローソン,1155,三井住友カード,未記入',
      '2026-08-19,ＪＡＬ航空券類,17710,三井住友カード,未記入',
    ].join('\n');
    const { rows, errors } = parsePasteText(text, ACCOUNTS);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      date: '2026-08-19',
      description: 'ローソン',
      amount: 115500,
      creditAccountId: 'card',
      debitAccountId: 'pending',
    });
    expect(rows[1]!.amount).toBe(1771000);
  });

  it('CRLF・空行・セル前後の空白を許す（それだけを許す）', () => {
    const text = '\r\n 2026-08-19 , ランチ , 800 , 現金 , 食費 \r\n\r\n';
    const { rows, errors } = parsePasteText(text, ACCOUNTS);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        date: '2026-08-19',
        description: 'ランチ',
        amount: 80000,
        creditAccountId: 'cash',
        debitAccountId: 'food',
      },
    ]);
  });

  it('小数 2 桁までを受ける（表示桁設定とは独立・保存は常に 1/100）', () => {
    const { rows, errors } = parsePasteText('2026-08-19,端数,12.34,現金,食費', ACCOUNTS);
    expect(errors).toEqual([]);
    expect(rows[0]!.amount).toBe(1234);
  });

  it('空テキストは 0 行・エラーなし（呼び出し側が「行なし」を出す）', () => {
    expect(parsePasteText('', ACCOUNTS)).toEqual({ rows: [], errors: [] });
  });
});

describe('parsePasteText 厳密性（寛容処理なし）', () => {
  it('5 項目ちょうどでない行は field-count', () => {
    const { errors } = parsePasteText('2026-08-19,ランチ,800,現金', ACCOUNTS);
    expect(errors).toEqual([{ kind: 'field-count', line: 1 }]);
  });

  it('摘要にカンマが入ると項目数ずれとして拒否（エスケープは無い）', () => {
    const { errors } = parsePasteText('2026-08-19,ランチ,と珈琲,800,現金,食費', ACCOUNTS);
    expect(errors).toEqual([{ kind: 'field-count', line: 1 }]);
  });

  it('日付の形・暦・上限を検証する', () => {
    for (const date of ['2026-8-19', '2026/08/19', '2026-02-30', '20260819']) {
      const { errors } = parsePasteText(`${date},x,800,現金,食費`, ACCOUNTS);
      expect(errors, date).toEqual([{ kind: 'date', line: 1 }]);
    }
    // 上限超え（MAX_LEDGER_DATE より後ろ）も入口で拒否する。
    const { errors } = parsePasteText(`9999-12-31,x,800,現金,食費`, ACCOUNTS);
    expect('9999-12-31' > MAX_LEDGER_DATE).toBe(true);
    expect(errors).toEqual([{ kind: 'date', line: 1 }]);
  });

  it('摘要は 1〜200 文字', () => {
    expect(parsePasteText('2026-08-19,,800,現金,食費', ACCOUNTS).errors).toEqual([
      { kind: 'description', line: 1 },
    ]);
    const long = 'あ'.repeat(201);
    expect(parsePasteText(`2026-08-19,${long},800,現金,食費`, ACCOUNTS).errors).toEqual([
      { kind: 'description', line: 1 },
    ]);
    expect(parsePasteText(`2026-08-19,${'あ'.repeat(200)},800,現金,食費`, ACCOUNTS).errors).toEqual(
      [],
    );
  });

  it('金額は正の数・小数 2 桁まで・符号や省略形は拒否', () => {
    for (const amount of ['0', '0.00', '-100', '12.345', 'abc', '.5', '12.', '']) {
      const { errors } = parsePasteText(`2026-08-19,x,${amount},現金,食費`, ACCOUNTS);
      expect(
        errors.some((e) => e.kind === 'amount' && e.line === 1),
        amount,
      ).toBe(true);
    }
    // 桁区切りカンマは区切り文字と衝突し、項目数ずれとして落ちる（黙って通さない）。
    expect(parsePasteText('2026-08-19,x,1,155,現金,食費', ACCOUNTS).errors).toEqual([
      { kind: 'field-count', line: 1 },
    ]);
  });

  it('科目名は完全一致（未知 = unknown-account・同名複数 = ambiguous-account）', () => {
    expect(parsePasteText('2026-08-19,x,800,現金,食  費', ACCOUNTS).errors).toEqual([
      { kind: 'unknown-account', line: 1, name: '食  費' },
    ]);
    const dup = [
      ...ACCOUNTS,
      account({ id: 'cash2', name: '現金', type: 'asset', role: 'daily-asset' }),
    ];
    expect(parsePasteText('2026-08-19,x,800,現金,食費', dup).errors).toEqual([
      { kind: 'ambiguous-account', line: 1, name: '現金' },
    ]);
  });

  it('継続コスト台帳は候補にしない（台帳仕訳は専用導線のみの不変条件）', () => {
    expect(parsePasteText('2026-08-19,x,800,現金,継続コスト台帳', ACCOUNTS).errors).toEqual([
      { kind: 'unknown-account', line: 1, name: '継続コスト台帳' },
    ]);
  });

  it('存在期間外の科目参照は account-period（期間内なら通る）', () => {
    expect(parsePasteText('2026-02-01,x,800,旧口座,食費', ACCOUNTS).errors).toEqual([
      { kind: 'account-period', line: 1, name: '旧口座' },
    ]);
    expect(parsePasteText('2026-01-31,x,800,旧口座,食費', ACCOUNTS).errors).toEqual([]);
  });

  it('貸方と借方が同じ科目は same-account', () => {
    expect(parsePasteText('2026-08-19,x,800,現金,現金', ACCOUNTS).errors).toEqual([
      { kind: 'same-account', line: 1 },
    ]);
  });

  it('エラーは全行ぶん行番号付きで列挙し、正しい行も rows に返さない運用ができる', () => {
    const text = [
      '2026-08-19,ランチ,800,現金,食費',
      'こわれた行',
      '2026-99-99,x,800,現金,食費',
    ].join('\n');
    const { rows, errors } = parsePasteText(text, ACCOUNTS);
    // 正しい 1 行目は rows に載る（登録しない判断は呼び出し側 = errors があれば全体停止）。
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([
      { kind: 'field-count', line: 2 },
      { kind: 'date', line: 3 },
    ]);
  });

  it('上限行数を超えたら too-many だけを返す', () => {
    const text = Array.from(
      { length: PASTE_MAX_ROWS + 1 },
      () => '2026-08-19,x,800,現金,食費',
    ).join('\n');
    expect(parsePasteText(text, ACCOUNTS).errors).toEqual([
      { kind: 'too-many', count: PASTE_MAX_ROWS + 1 },
    ]);
  });
});
