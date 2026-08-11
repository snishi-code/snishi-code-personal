/*
 * 投資の利回り投影（§D 2026-08-11）。
 *
 *  - エンジン（domain/investmentProjection.ts）: 月次複利の既知値・未来仕訳の織り込み・
 *    負利回りの逆向き行・各種ガード（bp 未設定/0・計上先欠落・role 不整合・自分自身）・
 *    2100 打ち切り・桁あふれ停止・過去断面の today 非依存。
 *  - API 分離（Codex 指摘の回帰）: reportEntriesForAsOf（保存不変条件）には投影が決して
 *    混ざらない。displayEntriesForAsOf（表示）だけに現れる。
 *  - 保存境界（repository）: セット必須・role ガード・soft reference（計上先が消えても
 *    改名できる）・残高補正の理論残高とアーカイブの残高 0 判定が投影の有無で不変。
 *  - 科目編集 UI の % ⇄ bp 変換。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  annualReturnBpToPercentText,
  monthlyReturnRate,
  parseAnnualReturnPercentText,
} from '../src/domain/investmentProjection';
import { displayEntriesForAsOf, reportEntriesForAsOf } from '../src/domain/reportEntries';
import {
  deriveBalanceSheet,
  deriveProfitAndLoss,
  equityNaturalDelta,
} from '../src/domain/accounting';
import { accountSchema, ledgerExportPackageSchema } from '../src/domain/schema';
import { APP_ID, SCHEMA_VERSION } from '../src/domain/constants';
import {
  createAdjustment,
  deleteAccount,
  loadLedger,
  upsertAccount,
  upsertEntry,
} from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import { nowIso } from '../src/util/time';
import type { Account, JournalEntry } from '../src/domain/types';

function account(
  id: string,
  name: string,
  type: Account['type'],
  role: Account['role'],
  over: Partial<Account> = {},
): Account {
  return {
    id,
    name,
    type,
    role,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function entry(
  id: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  amount: number,
  kind: JournalEntry['kind'] = 'normal',
): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind,
    lines: [
      { accountId: debitAccountId, side: 'debit', amount },
      { accountId: creditAccountId, side: 'credit', amount },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const invest = account('invest', '投資', 'asset', 'investment-asset', {
  annualReturnBp: 1200,
  projectionAccountId: 'gain',
});
const gain = account('gain', '投資益', 'revenue', 'income-category');
const cash = account('cash', '現金', 'asset', 'daily-asset');
const capital = account('capital', '初期残高', 'equity', 'equity');

function source(over: {
  accounts?: Account[];
  journalEntries?: JournalEntry[];
}): Parameters<typeof reportEntriesForAsOf>[0] {
  return {
    accounts: over.accounts ?? [invest, gain, cash, capital],
    journalEntries: over.journalEntries ?? [
      entry('opening', '2026-01-01', 'invest', 'capital', 100_000, 'opening'),
    ],
    monthlyCostItems: [],
    recurringRules: [],
  };
}

const TODAY = '2026-01-15';

function projectionRows(entries: JournalEntry[]): JournalEntry[] {
  return entries.filter((e) => e.metadata?.investmentProjectionOf !== undefined);
}

describe('investmentProjectionEntries: 月次複利', () => {
  // 月利 = (1 + 1200/10000)^(1/12) − 1 ≈ 0.0094887929…。既知値は
  // 100000 → 949 / 958 / 967 / 976 / 985（各月 Math.round で円へ丸め・決定的）。
  it('翌月初から月次複利の評価益を既知値どおり生成する（借方 投資 / 貸方 計上先）', () => {
    const rows = projectionRows(displayEntriesForAsOf(source({}), '2026-06-30', TODAY));
    expect(rows.map((r) => [r.date, r.lines[0]?.amount])).toEqual([
      ['2026-02-01', 949],
      ['2026-03-01', 958],
      ['2026-04-01', 967],
      ['2026-05-01', 976],
      ['2026-06-01', 985],
    ]);
    for (const row of rows) {
      expect(row.lines).toEqual([
        { accountId: 'invest', side: 'debit', amount: row.lines[0]!.amount },
        { accountId: 'gain', side: 'credit', amount: row.lines[0]!.amount },
      ]);
      expect(row.metadata).toEqual({ virtual: true, investmentProjectionOf: 'invest' });
      expect(row.description).toBe('投影: 投資');
      expect(row.id).toBe(`inv-proj-invest-${row.date.slice(0, 7)}`);
    }
  });

  it('要求 asOf で打ち切る（asOf より後の行は生まれない）', () => {
    const rows = projectionRows(displayEntriesForAsOf(source({}), '2026-04-15', TODAY));
    expect(rows.map((r) => r.date)).toEqual(['2026-02-01', '2026-03-01', '2026-04-01']);
  });

  it('各月の間の未来仕訳（積立）を残高へ織り込んで複利する', () => {
    const withDeposit = source({
      journalEntries: [
        entry('opening', '2026-01-01', 'invest', 'capital', 100_000, 'opening'),
        entry('deposit', '2026-02-20', 'invest', 'cash', 50_000),
      ],
    });
    const rows = projectionRows(displayEntriesForAsOf(withDeposit, '2026-04-30', TODAY));
    // 3 月分から元本 100000 + 949 + 50000 に対する評価益になる。
    expect(rows.map((r) => [r.date, r.lines[0]?.amount])).toEqual([
      ['2026-02-01', 949],
      ['2026-03-01', 1432],
      ['2026-04-01', 1446],
    ]);
  });

  it('負利回りは逆向きの行（借方 計上先 / 貸方 投資）になる', () => {
    const negative = source({
      accounts: [{ ...invest, annualReturnBp: -1200 }, gain, cash, capital],
    });
    const rows = projectionRows(displayEntriesForAsOf(negative, '2026-03-31', TODAY));
    expect(rows.map((r) => [r.date, r.lines[0]?.amount])).toEqual([
      ['2026-02-01', 1060],
      ['2026-03-01', 1048],
    ]);
    for (const row of rows) {
      expect(row.lines[0]).toMatchObject({ accountId: 'gain', side: 'debit' });
      expect(row.lines[1]).toMatchObject({ accountId: 'invest', side: 'credit' });
    }
  });
});

describe('investmentProjectionEntries: 生成しない条件（fail-closed）', () => {
  const expectNone = (accounts: Account[]) => {
    expect(
      projectionRows(displayEntriesForAsOf(source({ accounts }), '2027-12-31', TODAY)),
    ).toEqual([]);
  };

  it('bp 未設定・0 では 1 行も生まれない', () => {
    expectNone([{ ...invest, annualReturnBp: undefined as never }, gain, cash, capital]);
    expectNone([{ ...invest, annualReturnBp: 0 }, gain, cash, capital]);
  });

  it('計上先が欠落・存在しない・income-category でない・自分自身なら生まれない', () => {
    expectNone([{ ...invest, projectionAccountId: undefined as never }, gain, cash, capital]);
    expectNone([invest, cash, capital]); // gain が存在しない
    expectNone([{ ...invest, projectionAccountId: 'cash' }, gain, cash, capital]); // role 不整合
    expectNone([{ ...invest, projectionAccountId: 'invest' }, gain, cash, capital]); // 自分自身
  });

  it('investment-asset 以外の科目に bp が付いていても無視する', () => {
    const oddCash = { ...cash, annualReturnBp: 1200, projectionAccountId: 'gain' };
    const accounts = [{ ...invest, annualReturnBp: 0 }, gain, oddCash, capital];
    const src = source({
      accounts,
      journalEntries: [entry('opening', '2026-01-01', 'cash', 'capital', 100_000, 'opening')],
    });
    expect(projectionRows(displayEntriesForAsOf(src, '2027-12-31', TODAY))).toEqual([]);
  });

  it('残高 0 以下・評価益 0 円の月は行を生成しない', () => {
    // 残高 0（仕訳なし）
    expect(
      projectionRows(displayEntriesForAsOf(source({ journalEntries: [] }), '2026-12-31', TODAY)),
    ).toEqual([]);
    // 残高 10 円 × 月利 0.95% → 丸めて 0 円 = 行なし
    const tiny = source({
      journalEntries: [entry('opening', '2026-01-01', 'invest', 'capital', 10, 'opening')],
    });
    expect(projectionRows(displayEntriesForAsOf(tiny, '2026-12-31', TODAY))).toEqual([]);
  });

  it('アーカイブ（線分終了）後の月には生まれない', () => {
    const ended = source({
      accounts: [{ ...invest, archived: true, endDate: '2026-03-31' }, gain, cash, capital],
    });
    const rows = projectionRows(displayEntriesForAsOf(ended, '2026-12-31', TODAY));
    expect(rows.map((r) => r.date)).toEqual(['2026-02-01', '2026-03-01']);
  });
});

describe('investmentProjectionEntries: 上限', () => {
  it('CONTINUOUS_COST_HARD_CAP（2100 年）で打ち切る', () => {
    const rows = projectionRows(displayEntriesForAsOf(source({}), '2150-12-31', TODAY));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)!.date <= '2100-12-31').toBe(true);
  });

  it('桁あふれ: 残高が MAX_SAFE_INTEGER/2 を超える月から停止し、それ以前の行は維持する', () => {
    const huge = source({
      accounts: [
        { ...invest, annualReturnBp: 100_000 }, // 年率 1000% = 月利 ≈ 22.1%
        gain,
        cash,
        capital,
      ],
      journalEntries: [
        entry('opening', '2026-01-01', 'invest', 'capital', 3_500_000_000_000_000, 'opening'),
      ],
    });
    const rows = projectionRows(displayEntriesForAsOf(huge, '2027-12-31', TODAY));
    expect(rows.map((r) => [r.date, r.lines[0]?.amount])).toEqual([
      ['2026-02-01', 774_159_926_091_978],
    ]);
  });
});

describe('API 分離: 過去断面の today 非依存と保存不変条件の不変', () => {
  it('投影行は常に today より未来 = today 以前の断面は today を動かしても不変', () => {
    const src = source({});
    const early = displayEntriesForAsOf(src, '2026-12-31', '2026-03-15');
    const late = displayEntriesForAsOf(src, '2026-12-31', '2026-06-15');
    // どの today でも投影行は today より未来の日付のみ。
    expect(projectionRows(early).every((r) => r.date > '2026-03-15')).toBe(true);
    expect(projectionRows(late).every((r) => r.date > '2026-06-15')).toBe(true);
    // 両者の共通過去（<= 2026-03-15）のスライスは完全一致する。
    const slice = (entries: JournalEntry[]) =>
      entries
        .filter((e) => e.date <= '2026-03-15')
        .map((e) => e.id)
        .sort();
    expect(slice(early)).toEqual(slice(late));
    expect(slice(early)).toEqual(slice(reportEntriesForAsOf(src, '2026-12-31')));
  });

  it('reportEntriesForAsOf（保存不変条件）には投影が決して混ざらない', () => {
    const src = source({});
    expect(projectionRows(reportEntriesForAsOf(src, '2026-12-31'))).toEqual([]);
    expect(projectionRows(displayEntriesForAsOf(src, '2026-12-31', TODAY)).length).toBeGreaterThan(
      0,
    );
  });

  it('恒等式 Δ純資産 = 収支 + equity 自然増減が投影込みでも成立する', () => {
    const src = source({
      journalEntries: [
        entry('opening', '2026-01-01', 'invest', 'capital', 100_000, 'opening'),
        entry('deposit', '2026-02-20', 'invest', 'cash', 50_000),
        entry('cash-open', '2026-01-01', 'cash', 'capital', 200_000, 'opening'),
      ],
    });
    const accounts = src.accounts;
    const entries = displayEntriesForAsOf(src, '2026-12-31', TODAY);
    const bs = deriveBalanceSheet(accounts, entries, '2026-12-31');
    const pl = deriveProfitAndLoss(accounts, entries, { to: '2026-12-31' });
    expect(bs.netAssets).toBe(pl.netIncome + equityNaturalDelta(accounts, entries));
    // 投影の評価益が実際に収支側（収益）へ立っている（恒等式が退化していない）。
    expect(pl.totalRevenue).toBeGreaterThan(0);
  });
});

describe('monthlyReturnRate / % ⇄ bp 変換', () => {
  it('月利 = (1 + bp/10000)^(1/12) − 1', () => {
    expect(monthlyReturnRate(1200)).toBeCloseTo(Math.pow(1.12, 1 / 12) - 1, 15);
    expect(monthlyReturnRate(0)).toBe(0);
    expect(monthlyReturnRate(-1200)).toBeLessThan(0);
  });

  it('bp → % テキスト', () => {
    expect(annualReturnBpToPercentText(300)).toBe('3');
    expect(annualReturnBpToPercentText(325)).toBe('3.25');
    expect(annualReturnBpToPercentText(1050)).toBe('10.5');
    expect(annualReturnBpToPercentText(1)).toBe('0.01');
    expect(annualReturnBpToPercentText(-50)).toBe('-0.5');
    expect(annualReturnBpToPercentText(100_000)).toBe('1000');
  });

  it('% テキスト → bp（小数第 2 位まで・範囲外と不正は null）', () => {
    expect(parseAnnualReturnPercentText('3')).toBe(300);
    expect(parseAnnualReturnPercentText('3.25')).toBe(325);
    expect(parseAnnualReturnPercentText(' 10.5 ')).toBe(1050);
    expect(parseAnnualReturnPercentText('-0.5')).toBe(-50);
    expect(parseAnnualReturnPercentText('-99.99')).toBe(-9999);
    expect(parseAnnualReturnPercentText('1000')).toBe(100_000);
    expect(parseAnnualReturnPercentText('0.29')).toBe(29);
    for (const bad of ['', 'abc', '3.256', '1000.01', '-100', '3,5', '3.']) {
      expect(parseAnnualReturnPercentText(bad)).toBeNull();
    }
  });

  it('往復変換が恒等（bp → % → bp）', () => {
    for (const bp of [1, 29, 300, 325, 1050, 9999, 100_000, -1, -50, -9999]) {
      expect(parseAnnualReturnPercentText(annualReturnBpToPercentText(bp))).toBe(bp);
    }
  });
});

describe('schema: annualReturnBp / projectionAccountId', () => {
  const base = {
    id: 'inv',
    name: '投資',
    type: 'asset',
    role: 'investment-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };

  it('investment-asset にセットで付いていれば受理する', () => {
    expect(
      accountSchema.safeParse({ ...base, annualReturnBp: 300, projectionAccountId: 'gain' })
        .success,
    ).toBe(true);
    expect(
      accountSchema.safeParse({ ...base, annualReturnBp: -9999, projectionAccountId: 'gain' })
        .success,
    ).toBe(true);
  });

  it('片方だけ・自分自身・範囲外・小数・投資以外は拒否する', () => {
    expect(accountSchema.safeParse({ ...base, annualReturnBp: 300 }).success).toBe(false);
    expect(accountSchema.safeParse({ ...base, projectionAccountId: 'gain' }).success).toBe(false);
    expect(
      accountSchema.safeParse({ ...base, annualReturnBp: 300, projectionAccountId: 'inv' }).success,
    ).toBe(false);
    expect(
      accountSchema.safeParse({ ...base, annualReturnBp: 100_001, projectionAccountId: 'gain' })
        .success,
    ).toBe(false);
    expect(
      accountSchema.safeParse({ ...base, annualReturnBp: -10_000, projectionAccountId: 'gain' })
        .success,
    ).toBe(false);
    expect(
      accountSchema.safeParse({ ...base, annualReturnBp: 3.5, projectionAccountId: 'gain' })
        .success,
    ).toBe(false);
    expect(
      accountSchema.safeParse({
        ...base,
        role: 'daily-asset',
        annualReturnBp: 300,
        projectionAccountId: 'gain',
      }).success,
    ).toBe(false);
  });

  it('import は計上先の存在を要求しない（soft reference・消えた後の export を取り込める）', () => {
    const pkg = {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'dev1',
      revision: 0,
      accounts: [
        // projectionAccountId 'gone' はパッケージ内に存在しない = soft reference なので適法。
        { ...base, annualReturnBp: 300, projectionAccountId: 'gone' },
      ],
      journalEntries: [],
      tags: [],
      monthlyCostItems: [],
      recurringRules: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    };
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
  });
});

describe('保存境界（repository）', () => {
  async function seededAccounts() {
    const ledger = await loadLedger();
    const investAcc = ledger.accounts.find((a) => a.name === '投資')!;
    const income = ledger.accounts.find((a) => a.name === 'その他収入')!;
    const cashAcc = ledger.accounts.find((a) => a.name === '現金')!;
    const capitalAcc = ledger.accounts.find((a) => a.name === '初期残高')!;
    return { investAcc, income, cashAcc, capitalAcc };
  }

  it('セットで保存でき、片方だけ・投資以外・自分自身・未知の計上先は拒否する', async () => {
    const { investAcc, income, cashAcc } = await seededAccounts();
    await upsertAccount({
      ...investAcc,
      annualReturnBp: 325,
      projectionAccountId: income.id,
      updatedAt: nowIso(),
    });
    const saved = (await loadLedger()).accounts.find((a) => a.id === investAcc.id)!;
    expect(saved.annualReturnBp).toBe(325);
    expect(saved.projectionAccountId).toBe(income.id);

    await expect(
      upsertAccount({ ...saved, annualReturnBp: 325, projectionAccountId: undefined as never }),
    ).rejects.toMatchObject({ code: 'error.account.projectionPair' });
    await expect(
      upsertAccount({
        ...cashAcc,
        annualReturnBp: 325,
        projectionAccountId: income.id,
        updatedAt: nowIso(),
      }),
    ).rejects.toMatchObject({ code: 'error.account.returnOnlyInvestment' });
    await expect(upsertAccount({ ...saved, projectionAccountId: saved.id })).rejects.toMatchObject({
      code: 'error.account.projectionAccountInvalid',
    });
    await expect(
      upsertAccount({ ...saved, projectionAccountId: 'no-such-account' }),
    ).rejects.toMatchObject({ code: 'error.account.projectionAccountInvalid' });
    await expect(
      upsertAccount({ ...saved, projectionAccountId: cashAcc.id }),
    ).rejects.toMatchObject({ code: 'error.account.projectionAccountInvalid' });
  });

  it('soft reference: 計上先が消えても既存科目の編集（改名）は保存できる', async () => {
    const { investAcc, income } = await seededAccounts();
    await upsertAccount({
      ...investAcc,
      annualReturnBp: 300,
      projectionAccountId: income.id,
      updatedAt: nowIso(),
    });
    // 計上先は soft reference なので削除できる（使用中判定に入らない）。
    await deleteAccount(income.id);
    const stale = (await loadLedger()).accounts.find((a) => a.id === investAcc.id)!;
    expect(stale.projectionAccountId).toBe(income.id);
    // 参照先が消えた後でも改名は保存できる（値を変えない限り再検証しない・§A の教訓）。
    await upsertAccount({ ...stale, name: '投資（改名）', updatedAt: nowIso() });
    const renamed = (await loadLedger()).accounts.find((a) => a.id === investAcc.id)!;
    expect(renamed.name).toBe('投資（改名）');
    expect(renamed.projectionAccountId).toBe(income.id);
  });

  it('残高補正の理論残高に投影が混ざらない（未来日付の補正でも実残高ベース）', async () => {
    const { investAcc, income, capitalAcc } = await seededAccounts();
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-01-01',
        description: '初期',
        debitAccountId: investAcc.id,
        creditAccountId: capitalAcc.id,
        amount: 100_000,
      }),
    );
    await upsertAccount({
      ...(await loadLedger()).accounts.find((a) => a.id === investAcc.id)!,
      annualReturnBp: 1200,
      projectionAccountId: income.id,
      updatedAt: nowIso(),
    });
    // 未来日付の補正: 表示（displayEntries）なら評価益が乗る断面でも、保存される
    // expectedBalance は投影なしの 100000 のまま（Codex 指摘の回帰テスト）。
    const adjusted = await createAdjustment({
      accountId: investAcc.id,
      date: '2099-12-31',
      actualBalance: 90_000,
    });
    expect(adjusted?.metadata?.adjustment).toMatchObject({
      expectedBalance: 100_000,
      actualBalance: 90_000,
      delta: -10_000,
    });
  });

  it('科目アーカイブの残高 0 判定に投影が混ざらない（未来の終了点でもアーカイブできる）', async () => {
    const { investAcc, income, cashAcc, capitalAcc } = await seededAccounts();
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-01-01',
        description: '初期',
        debitAccountId: investAcc.id,
        creditAccountId: capitalAcc.id,
        amount: 100_000,
      }),
    );
    await upsertAccount({
      ...(await loadLedger()).accounts.find((a) => a.id === investAcc.id)!,
      annualReturnBp: 1200,
      projectionAccountId: income.id,
      updatedAt: nowIso(),
    });
    // 未来日付の引き出しで実残高を 0 にし、その日を終了点にする。表示上は終了点まで
    // 評価益の投影が乗り得るが、保存判断（残高 0）は投影なしの実質計算で行われる。
    await upsertEntry(
      buildSimpleEntry({
        date: '2099-12-31',
        description: '全額引き出し',
        debitAccountId: cashAcc.id,
        creditAccountId: investAcc.id,
        amount: 100_000,
      }),
    );
    const current = (await loadLedger()).accounts.find((a) => a.id === investAcc.id)!;
    await upsertAccount({
      ...current,
      archived: true,
      endDate: '2099-12-31',
      updatedAt: nowIso(),
    });
    const archived = (await loadLedger()).accounts.find((a) => a.id === investAcc.id)!;
    expect(archived.archived).toBe(true);
    expect(archived.endDate).toBe('2099-12-31');
  });
});
