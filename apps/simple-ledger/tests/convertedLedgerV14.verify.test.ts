/*
 * v13→v14 変換スクリプト（convert-ledger-v13-to-v14.mjs・リポジトリ外）の検証。
 *
 * 2 段構成（v12→v13 の verify テストと同じ型式）:
 *  (a) 合成フィクスチャ: 実スクリプトをサブプロセス実行し、ローンルール → ローン item 化・
 *      借入仕訳への loanItemId 付与・memo の保全つき撤去・壊れ pin の修復を、
 *      実 schema（v14）と実 import まで通して検証する。変換不能（終了日なし・清算持ち・
 *      借入仕訳の曖昧・月額改変・計上先負債の持ち物）は列挙して中断することを固定する。
 *  (b) 手動ゲート: CONVERTED_LEDGER_JSON=<変換済みJSON> を渡したときだけ、実データを
 *      実 schema + 実 import で検証する（skip = 移行確認済みという意味ではない）。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import './setup';
import { APP_ID, SCHEMA_VERSION } from '../src/data/constants';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { importFromJsonText } from '../src/data/exportImport';
import { accountBalance } from '../src/domain/accounting';
import { isFreeAsset } from '../src/domain/cashflow';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { isLoanItem } from '../src/domain/loan';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import type { Account, JournalEntry, RecurringRule } from '../src/domain/types';

/** cwd から親へ最大 8 階層、_workspace-management/scripts/ の変換スクリプトを探す。 */
function findConverter(): string | undefined {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, '../_workspace-management/scripts/convert-ledger-v13-to-v14.mjs');
    if (existsSync(candidate)) return resolve(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
const CONVERTER = findConverter();

function runConverter(pkg: unknown): { out: Record<string, unknown>; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-v14-'));
  const src = join(dir, 'src-v13.json');
  const dst = join(dir, 'out-v14.json');
  writeFileSync(src, JSON.stringify(pkg, null, 2));
  const stdout = execFileSync('node', [CONVERTER!, src, dst], { encoding: 'utf8' });
  const sidecar = readFileSync(`${dst}.source.sha256`, 'utf8');
  const actual = createHash('sha256').update(readFileSync(src)).digest('hex');
  expect(sidecar.startsWith(actual)).toBe(true);
  return { out: JSON.parse(readFileSync(dst, 'utf8')) as Record<string, unknown>, stdout };
}

/** 変換不能で中断する入力（exit ≠ 0）の stderr を返す。 */
function runConverterExpectFail(pkg: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-v14-ng-'));
  const src = join(dir, 'src-v13.json');
  const dst = join(dir, 'out-v14.json');
  writeFileSync(src, JSON.stringify(pkg, null, 2));
  try {
    execFileSync('node', [CONVERTER!, src, dst], { encoding: 'utf8' });
  } catch (error) {
    const e = error as { status?: number; stderr?: string };
    expect(e.status).not.toBe(0);
    expect(existsSync(dst)).toBe(false);
    return e.stderr ?? '';
  }
  throw new Error('変換が成功してしまいました（中断されるべき入力）');
}

/* ── 合成 v13 フィクスチャ ── */

const TS = '2026-01-10T00:00:00.000Z';
const account = (over: Partial<Account> & Pick<Account, 'id' | 'name' | 'type' | 'role'>) => ({
  archived: false,
  createdAt: TS,
  updatedAt: TS,
  ...over,
});

const CASH = 'cash';
const EXPENSE = 'expense';
const LIAB = 'liab-car';
const ADJ_EXPENSE = 'adj-expense';
const ADJ_REVENUE = 'adj-revenue';

/** v13 の「ローンで払う」が作った形: 負債 + 借入仕訳（貸方 = 負債）+ 返済ルール。 */
function loanRuleFixture() {
  // 借入 10,000 を 2026-01-10 に。初回返済 2026-02-10・6 回 → 排他的終了日 2026-08-10。
  const rule: RecurringRule = {
    id: 'loan-rule',
    name: '家電ローン',
    amount: 1666, // floor(10000 / 6)
    dayOfMonth: 10,
    everyMonths: 1,
    spreadExpenseAccountId: LIAB,
    debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    creditAccountId: CASH,
    startMonth: '2026-02',
    startDate: '2026-01-10',
    endDate: '2026-08-10',
    createdAt: TS,
    updatedAt: TS,
  };
  const borrow: JournalEntry = {
    id: 'borrow-1',
    date: '2026-01-10',
    description: '家電ローン',
    kind: 'normal',
    lines: [
      { accountId: EXPENSE, side: 'debit', amount: 10000 },
      { accountId: LIAB, side: 'credit', amount: 10000 },
    ],
    metadata: { inputMode: 'expense' },
    createdAt: TS,
    updatedAt: TS,
  } as JournalEntry;
  return { rule, borrow };
}

function v13Package(over: Record<string, unknown> = {}) {
  const { rule, borrow } = loanRuleFixture();
  const opening: JournalEntry = {
    id: 'open-cash',
    date: '2026-01-01',
    description: '初期残高',
    kind: 'opening',
    lines: [
      { accountId: CASH, side: 'debit', amount: 500000 },
      { accountId: 'equity', side: 'credit', amount: 500000 },
    ],
    metadata: { inputMode: 'manual' },
    createdAt: TS,
    updatedAt: TS,
  };
  const withMemo = {
    id: 'memo-entry',
    date: '2026-01-05',
    description: 'ランチ',
    kind: 'normal',
    lines: [
      { accountId: EXPENSE, side: 'debit', amount: 800 },
      { accountId: CASH, side: 'credit', amount: 800 },
    ],
    metadata: { inputMode: 'expense' },
    memo: '同僚と。領収書は引き出し',
    createdAt: TS,
    updatedAt: TS,
  };
  return {
    appId: APP_ID,
    schemaVersion: 13,
    ledgerId: 'ledger',
    exportedAt: '2026-08-21T00:00:00.000Z',
    deviceId: 'device',
    revision: 0,
    accounts: [
      account({ id: CASH, name: '現金', type: 'asset', role: 'daily-asset' }),
      account({ id: 'equity', name: '初期残高', type: 'equity', role: 'equity' }),
      account({ id: EXPENSE, name: '固定費', type: 'expense', role: 'expense-category' }),
      account({ id: LIAB, name: '家電ローン', type: 'liability', role: 'other-liability' }),
      account({ id: ADJ_EXPENSE, name: '残高調整費', type: 'expense', role: 'system-adjustment' }),
      account({ id: ADJ_REVENUE, name: '残高調整益', type: 'revenue', role: 'system-adjustment' }),
      account({
        id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        name: '月割り台帳',
        type: 'asset',
        role: 'continuing-cost-asset',
      }),
    ],
    journalEntries: [opening, withMemo, borrow],
    monthlyCostItems: [],
    recurringRules: [rule],
    settings: { ledgerName: '家計簿', currency: '円', displayFractionDigits: 0 },
    ...over,
  };
}

describe.skipIf(CONVERTER === undefined)('v13→v14 変換（合成フィクスチャ）', () => {
  it('ローンルール → ローン item 化・memo 保全つき撤去を経て v14 schema と実 import を通る', async () => {
    const { out, stdout } = runConverter(v13Package());

    expect(out.schemaVersion).toBe(14);
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    const parsed = ledgerExportPackageSchema.safeParse(out);
    if (!parsed.success) {
      throw new Error(`v14 schema が拒否: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
    }
    const pkg = parsed.data;

    // ルールは消え、ローン item が生まれる（④ 排他的終了日 2026-08-10 → 完済日 2026-07-10）。
    expect(pkg.recurringRules).toHaveLength(0);
    expect(pkg.monthlyCostItems).toHaveLength(1);
    const item = pkg.monthlyCostItems[0]!;
    expect(isLoanItem(item)).toBe(true);
    expect(item.expenseAccountId).toBe(LIAB);
    expect(item.repaymentSourceAccountId).toBe(CASH);
    expect(item.amount).toBe(10000);
    expect(item.startDate).toBe('2026-01-10');
    expect(item.endDate).toBe('2026-07-10');

    // 借入仕訳に loanItemId が付く（金額・日付ミラー）。
    const borrow = pkg.journalEntries.find((e) => e.id === 'borrow-1')!;
    expect(borrow.metadata?.loanItemId).toBe(item.id);

    // memo は field ごと消え、非空の全文が変換ログへ保全される（mutation: 保全を
    // 落とすとこの検査が落ちる・§6-5）。
    expect(pkg.journalEntries.some((e) => 'memo' in e)).toBe(false);
    expect(stdout).toContain('memo 非空の仕訳: 1 件');
    expect(stdout).toContain('同僚と。領収書は引き出し');

    // アプリ本体の導出とクロス検証: 完済日で負債はちょうど 0（合計厳密一致）・台帳は常に 0。
    const world = {
      accounts: pkg.accounts,
      journalEntries: pkg.journalEntries,
      monthlyCostItems: pkg.monthlyCostItems,
      recurringRules: pkg.recurringRules,
    };
    expect(accountBalance(LIAB, 'liability', reportEntriesForAsOf(world, '2026-07-10'))).toBe(0);
    expect(
      accountBalance(
        CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        'asset',
        reportEntriesForAsOf(world, '2026-07-10'),
      ),
    ).toBe(0);

    // 実 import（空 DB）まで通る。
    const outcome = await importFromJsonText(JSON.stringify(out));
    expect(outcome.kind).toBe('ok');
  });

  it('変換不能は列挙して中断する（終了日なし・清算持ち・借入仕訳の曖昧・月額改変・計上先負債の持ち物）', () => {
    const base = v13Package() as ReturnType<typeof v13Package> & {
      recurringRules: RecurringRule[];
      journalEntries: JournalEntry[];
    };

    // 終了日なし。
    const noEnd = structuredClone(base);
    delete (noEnd.recurringRules[0] as Partial<RecurringRule>).endDate;
    expect(runConverterExpectFail(noEnd)).toContain('終了日がありません');

    // 清算持ち。
    const withSettlement = structuredClone(base);
    withSettlement.recurringRules[0]!.settlements = [{ month: '2026-02', endDate: '2026-02-20' }];
    expect(runConverterExpectFail(withSettlement)).toContain('清算');

    // 借入仕訳の曖昧（同日・同負債・同名の 2 本）。
    const ambiguous = structuredClone(base);
    ambiguous.journalEntries.push({
      ...ambiguous.journalEntries.find((e) => e.id === 'borrow-1')!,
      id: 'borrow-2',
    });
    expect(runConverterExpectFail(ambiguous)).toContain('借入仕訳を同定できません');

    // 月額改変（作者が手でルール額を変えた等）。
    const tampered = structuredClone(base);
    tampered.recurringRules[0]!.amount = 2000;
    expect(runConverterExpectFail(tampered)).toContain('floor');

    // 計上先が負債の持ち物（監査 #4）。
    const liabilityItem = structuredClone(base);
    (liabilityItem.monthlyCostItems as unknown[]).push({
      id: 'orphan-item',
      name: '片肺ローン',
      amount: 5000,
      startDate: '2026-01-10',
      endDate: '2026-06-10',
      expenseAccountId: LIAB,
      createdAt: TS,
      updatedAt: TS,
    });
    expect(runConverterExpectFail(liabilityItem)).toContain('計上先が負債');
  });

  it('旧・投資投影の宣言を strip し、investment-asset を daily-asset + movable:false へ付け替える（v13.17 / v13.18）', () => {
    const base = v13Package() as ReturnType<typeof v13Package> & { accounts: unknown[] };
    base.accounts.push(
      {
        id: 'invest',
        name: '投資',
        type: 'asset',
        role: 'investment-asset',
        archived: false,
        createdAt: TS,
        updatedAt: TS,
        annualReturnBp: 300,
        projectionAccountId: 'gain',
      },
      account({ id: 'gain', name: '投資益', type: 'revenue', role: 'income-category' }),
    );
    const { out, stdout } = runConverter(base);
    const invest = (out as { accounts: Record<string, unknown>[] }).accounts.find(
      (a) => a.id === 'invest',
    )!;
    expect('annualReturnBp' in invest).toBe(false);
    expect('projectionAccountId' in invest).toBe(false);
    // 黙って落とさない（mutation (b): strip の報告を外すとこのログ検査が落ちる・§6-5）。
    expect(stdout).toContain('投資（利回り投影）宣言の strip（v13.17 撤去・1 科目）');
    expect(stdout).toContain('投資（invest）');
    expect(stdout).toContain('annualReturnBp=300');
    // v13.18: role は daily-asset + movable:false へ付け替え（新規回帰①: 原資に入らない。
    // mutation (a): スクリプトの movable:false 付与を外すと isFreeAsset が true になり落ちる）。
    expect(invest.role).toBe('daily-asset');
    expect(invest.movable).toBe(false);
    expect(isFreeAsset(invest as unknown as Account)).toBe(false);
    expect(stdout).toContain('投資 role の付け替え（v13.18 撤去・1 科目）');
    // 付け替え済みなので v14 schema（investment-asset は enum から撤去済み）を通る。
    expect(ledgerExportPackageSchema.safeParse(out).success).toBe(true);
  });

  it('investment-asset のままの JSON は v14 schema が拒否する（変換経由でのみ v14 に入る・v13.18）', () => {
    const base = v13Package() as ReturnType<typeof v13Package> & { accounts: unknown[] };
    base.accounts.push({
      id: 'invest',
      name: '投資',
      type: 'asset',
      role: 'investment-asset',
      archived: false,
      createdAt: TS,
      updatedAt: TS,
    });
    const { out } = runConverter(base);
    // 変換前の形（= 旧 role が残る形）は import 拒否・変換後は受理。
    expect(ledgerExportPackageSchema.safeParse({ ...out, accounts: base.accounts }).success).toBe(
      false,
    );
    expect(ledgerExportPackageSchema.safeParse(out).success).toBe(true);
  });

  it('壊れた補正 pin を修復して出力する（相手科目消失 → 付け替え / 対象消失 → 削除）', () => {
    const base = v13Package() as ReturnType<typeof v13Package> & {
      journalEntries: JournalEntry[];
    };
    // 相手科目が存在しない pin（現金 +100 の補正）→ 残高調整益へ付け替え。
    base.journalEntries.push({
      id: 'pin-broken-counterpart',
      date: '2026-01-20',
      description: '残高補正',
      kind: 'normal',
      lines: [
        { accountId: CASH, side: 'debit', amount: 100 },
        { accountId: 'ghost-adj', side: 'credit', amount: 100 },
      ],
      metadata: {
        adjustment: {
          accountId: CASH,
          expectedBalance: 0,
          actualBalance: 100,
          delta: 100,
          counterpartAccountId: 'ghost-adj',
        },
      },
      createdAt: TS,
      updatedAt: TS,
    });
    // 対象科目が存在しない pin → 削除。
    base.journalEntries.push({
      id: 'pin-broken-target',
      date: '2026-01-21',
      description: '残高補正',
      kind: 'normal',
      lines: [
        { accountId: 'ghost-target', side: 'debit', amount: 50 },
        { accountId: ADJ_REVENUE, side: 'credit', amount: 50 },
      ],
      metadata: {
        adjustment: {
          accountId: 'ghost-target',
          expectedBalance: 0,
          actualBalance: 50,
          delta: 50,
          counterpartAccountId: ADJ_REVENUE,
        },
      },
      createdAt: TS,
      updatedAt: TS,
    });
    const { out, stdout } = runConverter(base);
    expect(stdout).toContain('壊れた補正 pin の修復');
    const entries = (out as { journalEntries: JournalEntry[] }).journalEntries;
    const repaired = entries.find((e) => e.id === 'pin-broken-counterpart')!;
    expect(repaired.metadata?.adjustment?.counterpartAccountId).toBe(ADJ_REVENUE);
    expect(repaired.lines.find((l) => l.side === 'credit')?.accountId).toBe(ADJ_REVENUE);
    expect(entries.some((e) => e.id === 'pin-broken-target')).toBe(false);
    // 修復後は v14 schema を通る。
    expect(ledgerExportPackageSchema.safeParse(out).success).toBe(true);
  });
});

/* ── 手動ゲート（実データ）── */
const convertedPath = process.env.CONVERTED_LEDGER_JSON;

describe.skipIf(!convertedPath)('v13→v14 変換（実データ・手動ゲート）', () => {
  // skip は「未確認」を意味する。実データ移行の前に必ず CONVERTED_LEDGER_JSON を渡して実行する。
  it('変換済み実データが v14 schema と実 import を通る', async () => {
    const text = readFileSync(convertedPath!, 'utf8');
    const parsed = ledgerExportPackageSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`v14 schema が拒否: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`);
    }
    const outcome = await importFromJsonText(text);
    expect(outcome.kind).toBe('ok');
  });
});
