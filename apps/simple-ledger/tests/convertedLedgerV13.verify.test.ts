/*
 * v12→v13 変換スクリプト（convert-ledger-v12-to-v13.mjs・リポジトリ外）の検証。
 *
 * 2 段構成（v11→v12 の verify テストと同じ型式）:
 *  (a) 合成フィクスチャ: 実スクリプトをサブプロセス実行し、スキップの線分手術・
 *      構造的逸脱の降格・値の逸脱の置換・早期アーカイブ→settlements・参照の付け替えを、
 *      実 schema（v13）と実 import まで通して検証する。
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
import { loadLedger } from '../src/data/repository';
import { recurringRuleItemEndDate } from '../src/domain/accountLifetime';
import { deriveRecurringOutputs } from '../src/domain/recurring';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import type { Account, JournalEntry, RecurringRule } from '../src/domain/types';

/** cwd から親へ最大 8 階層、_workspace-management/scripts/ の変換スクリプトを探す。 */
function findConverter(): string | undefined {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, '../_workspace-management/scripts/convert-ledger-v12-to-v13.mjs');
    if (existsSync(candidate)) return resolve(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
const CONVERTER = findConverter();

function verifySourceSidecar(outPath: string, srcPath: string): void {
  const sidecar = readFileSync(`${outPath}.source.sha256`, 'utf8');
  const actual = createHash('sha256').update(readFileSync(srcPath)).digest('hex');
  expect(sidecar.startsWith(actual)).toBe(true);
}

function runConverter(pkg: unknown): { out: Record<string, unknown>; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-v13-'));
  const src = join(dir, 'src-v12.json');
  const dst = join(dir, 'out-v13.json');
  writeFileSync(src, JSON.stringify(pkg, null, 2));
  const stdout = execFileSync('node', [CONVERTER!, src, dst], { encoding: 'utf8' });
  verifySourceSidecar(dst, src);
  return { out: JSON.parse(readFileSync(dst, 'utf8')) as Record<string, unknown>, stdout };
}

/* ── 合成 v12 フィクスチャ ── */

const account = (over: Partial<Account> & Pick<Account, 'id' | 'name' | 'type' | 'role'>) => ({
  archived: false,
  startDate: '2026-01-01',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const CASH = 'cash';
const EXPENSE = 'expense';

function rule(over: Partial<RecurringRule> & Pick<RecurringRule, 'id'>): RecurringRule {
  return {
    name: over.id,
    amount: 1000,
    dayOfMonth: 20,
    everyMonths: 1,
    debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    spreadExpenseAccountId: EXPENSE,
    creditAccountId: CASH,
    startMonth: '2026-04',
    startDate: '2026-04-12',
    createdAt: '2026-04-12T00:00:00.000Z',
    updatedAt: '2026-04-12T00:00:00.000Z',
    ...over,
  } as RecurringRule;
}

function storedPosting(r: RecurringRule, month: string, amount = r.amount): JournalEntry {
  const date = `${month}-${String(r.dayOfMonth).padStart(2, '0')}`;
  return {
    id: `rec-${r.id}-${month}`,
    date,
    description: r.name,
    kind: 'normal',
    lines: [
      { accountId: r.debitAccountId, side: 'debit', amount },
      { accountId: r.creditAccountId, side: 'credit', amount },
    ],
    metadata: {
      inputMode: 'expense',
      recurringRuleId: r.id,
      recurringMonth: month,
      ...(r.spreadExpenseAccountId !== undefined ? { monthlyCostId: `ccr-${r.id}-${month}` } : {}),
    },
    createdAt: '2026-04-12T00:00:00.000Z',
    updatedAt: '2026-04-12T00:00:00.000Z',
  };
}

function storedItem(r: RecurringRule, month: string, endDate?: string) {
  const start = `${month}-${String(r.dayOfMonth).padStart(2, '0')}`;
  return {
    id: `ccr-${r.id}-${month}`,
    name: r.name,
    amount: r.amount,
    startDate: start,
    endDate: endDate ?? recurringRuleItemEndDate(month, r.everyMonths, r.dayOfMonth),
    expenseAccountId: r.spreadExpenseAccountId!,
    createdAt: '2026-04-12T00:00:00.000Z',
    updatedAt: '2026-04-12T00:00:00.000Z',
  };
}

function v12Package() {
  // R1: 正常 3 起票 + 値の逸脱 1 件（06 の保存金額 1100）+ 04 item の早期アーカイブ（→ settlements）
  const r1 = rule({ id: 'r1', postedThroughMonth: '2026-06' } as Partial<RecurringRule> & {
    id: string;
  });
  // R2: 先頭スキップ（04 が未保存・カーソルは 05 まで）→ startDate 後ろ倒し
  const r2 = rule({ id: 'r2', postedThroughMonth: '2026-05' } as Partial<RecurringRule> & {
    id: string;
  });
  // R3: 中抜きスキップ（05 が未保存）→ 中割り + 06 参照の付け替え
  const r3 = rule({ id: 'r3', postedThroughMonth: '2026-06' } as Partial<RecurringRule> & {
    id: string;
  });
  // R4: 構造的逸脱（保存の借方が台帳でなく費用へ直接）→ 手動仕訳へ降格
  const r4 = rule({ id: 'r4', postedThroughMonth: '2026-04' } as Partial<RecurringRule> & {
    id: string;
  });

  const r1Recovery: JournalEntry = {
    id: 'recovery-r1',
    date: '2026-05-01',
    description: 'r1',
    kind: 'normal',
    lines: [
      { accountId: CASH, side: 'debit', amount: 300 },
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount: 300 },
    ],
    metadata: { inputMode: 'transfer', monthlyCostId: 'ccr-r1-2026-04', monthlyCostRecovery: true },
    createdAt: 'x',
    updatedAt: 'x',
  };
  const r3Recovery: JournalEntry = {
    id: 'recovery-r3',
    date: '2026-06-25',
    description: 'r3',
    kind: 'normal',
    lines: [
      { accountId: CASH, side: 'debit', amount: 100 },
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount: 100 },
    ],
    metadata: { inputMode: 'transfer', monthlyCostId: 'ccr-r3-2026-06', monthlyCostRecovery: true },
    createdAt: 'x',
    updatedAt: 'x',
  };
  const r4Direct: JournalEntry = {
    ...storedPosting(r4, '2026-04'),
    lines: [
      { accountId: EXPENSE, side: 'debit', amount: 1000 },
      { accountId: CASH, side: 'credit', amount: 1000 },
    ],
  };
  delete (r4Direct.metadata as Record<string, unknown>).monthlyCostId;

  return {
    appId: APP_ID,
    schemaVersion: 12,
    ledgerId: 'ledger',
    exportedAt: '2026-06-30T00:00:00.000Z',
    deviceId: 'device',
    revision: 0,
    accounts: [
      account({ id: CASH, name: '現金', type: 'asset', role: 'daily-asset' }),
      account({ id: EXPENSE, name: '固定費', type: 'expense', role: 'expense-category' }),
      account({
        id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        name: '継続コスト台帳',
        type: 'asset',
        role: 'continuing-cost-asset',
      }),
    ],
    journalEntries: [
      storedPosting(r1, '2026-04'),
      storedPosting(r1, '2026-05'),
      storedPosting(r1, '2026-06', 1100), // 値の逸脱（導出 1000 へ置換・ログ）
      r1Recovery,
      storedPosting(r2, '2026-05'), // 04 はスキップ
      storedPosting(r3, '2026-04'),
      storedPosting(r3, '2026-06'), // 05 はスキップ（中抜き）
      r3Recovery,
      r4Direct, // 構造的逸脱
    ],
    tags: [
      { id: 'trip', name: '旅行', scope: 'entry', archived: false, createdAt: 'x', updatedAt: 'x' },
    ],
    monthlyCostItems: [
      storedItem(r1, '2026-04', '2026-05-01'), // 早期アーカイブ → settlements へ
      storedItem(r1, '2026-05'),
      storedItem(r1, '2026-06'),
      storedItem(r2, '2026-05'),
      storedItem(r3, '2026-04'),
      storedItem(r3, '2026-06'),
    ],
    recurringRules: [r1, r2, r3, r4],
    settings: { ledgerName: '家計簿', currency: 'JPY', displayFractionDigits: 0 },
  };
}

describe.skipIf(CONVERTER === undefined)('v12→v13 変換（合成フィクスチャ）', () => {
  it('手術・降格・置換・settlements 移設を経て v13 schema と実 import を通る', async () => {
    const { out, stdout } = runConverter(v12Package());

    // 封筒と全体構造。
    expect(out.schemaVersion).toBe(13);
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out).not.toHaveProperty('tags');
    const parsed = ledgerExportPackageSchema.safeParse(out);
    if (!parsed.success) {
      throw new Error(`v13 schema が拒否: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
    }
    const pkg = parsed.data;

    // 保存 rec-/ccr-/カーソルの消滅。
    expect(pkg.journalEntries.some((e) => e.id.startsWith('rec-'))).toBe(false);
    expect(pkg.monthlyCostItems.length).toBe(0);
    expect(pkg.recurringRules.every((r) => !('postedThroughMonth' in r))).toBe(true);

    const byId = new Map(pkg.recurringRules.map((r) => [r.id, r] as const));
    const accounts = pkg.accounts;

    // R1: 早期アーカイブが settlements へ移り、導出が保存月（04-06）を再現する。
    const r1 = byId.get('r1')!;
    expect(r1.settlements).toEqual([{ month: '2026-04', endDate: '2026-05-01' }]);
    const r1Derived = deriveRecurringOutputs([r1], accounts, '2026-06-30');
    expect(r1Derived.entries.map((e) => e.metadata?.recurringMonth)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
    // 値の逸脱（1100）は導出値（1000）が勝ち、ログに出る。
    expect(r1Derived.entries.every((e) => e.lines[0]!.amount === 1000)).toBe(true);
    expect(stdout).toContain('amount');
    // settlements が導出 item の endDate を上書きする。
    expect(r1Derived.items.find((m) => m.id === 'ccr-r1-2026-04')?.endDate).toBe('2026-05-01');
    // 回収の振替は実仕訳として温存。
    expect(pkg.journalEntries.some((e) => e.metadata?.monthlyCostId === 'ccr-r1-2026-04')).toBe(
      true,
    );

    // R2: 先頭スキップ → startDate が 04 の起票日を跨いで後ろへ（04 は導出されない）。
    const r2 = byId.get('r2')!;
    expect(r2.startDate > '2026-04-20').toBe(true);
    // 06 は v12 ではカーソル以降の投影だった月。v13 の導出はそれも同じ資格で出す（正しい）。
    expect(
      deriveRecurringOutputs([r2], accounts, '2026-06-30').entries.map(
        (e) => e.metadata?.recurringMonth,
      ),
    ).toEqual(['2026-05', '2026-06']);

    // R3: 中抜きスキップ → 中割りで後継線分が生まれ、06 は後継が導出・回収の参照も付け替え。
    const r3 = byId.get('r3')!;
    const r3Successor = pkg.recurringRules.find((r) => r.splitFromRuleId === 'r3')!;
    expect(r3Successor).toBeDefined();
    expect(r3.endDate).toBe('2026-05-20');
    const r3World = deriveRecurringOutputs([r3, r3Successor], accounts, '2026-06-30');
    expect(
      r3World.entries.map((e) => `${e.metadata?.recurringRuleId}:${e.metadata?.recurringMonth}`),
    ).toEqual(['r3:2026-04', `${r3Successor.id}:2026-06`]);
    expect(pkg.journalEntries.find((e) => e.id === 'recovery-r3')?.metadata?.monthlyCostId).toBe(
      `ccr-${r3Successor.id}-2026-06`,
    );

    // R4: 構造的逸脱 → 手動仕訳へ降格（残高不変・由来なし）・当月は導出から除外。
    const r4 = byId.get('r4')!;
    const demoted = pkg.journalEntries.find(
      (e) => e.description === 'r4' && e.date === '2026-04-20',
    )!;
    expect(demoted).toBeDefined();
    expect(demoted.id.startsWith('rec-')).toBe(false);
    expect(demoted.metadata?.recurringRuleId).toBeUndefined();
    expect(demoted.lines[0]).toEqual({ accountId: EXPENSE, side: 'debit', amount: 1000 });
    expect(deriveRecurringOutputs([r4], accounts, '2026-04-30').entries).toEqual([]);
    expect(stdout).toContain('降格');

    // 実 import まで通る（v13 アプリの受け入れ）。
    const outcome = await importFromJsonText(JSON.stringify(out), { force: true });
    expect(outcome.kind).toBe('ok');
    const ledger = await loadLedger();
    expect(ledger.recurringRules.length).toBe(pkg.recurringRules.length);
    expect(ledger.monthlyCostItems.length).toBe(0);
  });

  it('版違い・出力既存・不正引数は fail-closed に拒否する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-v13-ng-'));
    const src = join(dir, 'src.json');
    writeFileSync(src, JSON.stringify({ ...v12Package(), schemaVersion: 11 }));
    const dst = join(dir, 'out.json');
    expect(() => execFileSync('node', [CONVERTER!, src, dst], { encoding: 'utf8' })).toThrow();
    // 成功実行 → 同じ出力パスは上書き拒否。
    writeFileSync(src, JSON.stringify(v12Package()));
    execFileSync('node', [CONVERTER!, src, dst], { encoding: 'utf8' });
    expect(() => execFileSync('node', [CONVERTER!, src, dst], { encoding: 'utf8' })).toThrow();
    // オプション引数は受け付けない。
    expect(() =>
      execFileSync('node', [CONVERTER!, '--force', src, join(dir, 'out2.json')], {
        encoding: 'utf8',
      }),
    ).toThrow();
  });
});

/* ── 手動ゲート（実データ・目視用） ── */
const targetPath = process.env.CONVERTED_LEDGER_JSON;

describe.skipIf(!targetPath)('実データの v13 変換 JSON を検証する（手動ゲート）', () => {
  // skip は「未確認」を意味する。実データ移行の前に必ず CONVERTED_LEDGER_JSON で実行する。
  it('実 schema を通り、実 import で読める', async () => {
    const text = readFileSync(targetPath!, 'utf8');
    const parsed = ledgerExportPackageSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`v13 schema が拒否: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`);
    }
    const outcome = await importFromJsonText(text, { force: true });
    expect(outcome.kind).toBe('ok');
    const ledger = await loadLedger();
    console.log(
      `[手動ゲート] 科目 ${ledger.accounts.length} / 仕訳 ${ledger.journalEntries.length} / ` +
        `継続コスト ${ledger.monthlyCostItems.length} / ルール ${ledger.recurringRules.length}`,
    );
    expect(ledger.recurringRules.length).toBeGreaterThan(0);
  });
});
