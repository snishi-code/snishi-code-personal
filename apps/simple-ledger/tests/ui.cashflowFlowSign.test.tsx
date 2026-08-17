/*
 * 資金繰りの「先の入出金・振替予定」= フローの符号（v13.6 H2-2・作者確定 2026-08-18）。
 *
 * 固定するもの:
 *  - フロー行の数字は**絶対値**で、+ / − の符号を付けない。
 *  - 方向は**色**（.amount--pos / .amount--neg）で示す。
 *  - 色だけに頼らないため、金額の手前に **sr-only の言葉**（入金 / 出金 / 増減なし）を置く。
 *  - **画面上部の残高（ストック）は signed のまま** = 符号を消したのはフローだけ。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Cashflow } from '../src/ui/screens/Cashflow';
import type { Account, JournalEntry, Ledger } from '../src/domain/types';
import { SCHEMA_VERSION } from '../src/domain/constants';
import { UI } from '../src/ui-contract';
import './setup';

const ledgerState = vi.hoisted(() => ({ ledger: null as Ledger | null }));

vi.mock('../src/state/store', () => ({
  useLedger: () => ({ ledger: ledgerState.ledger }),
  useOptionalLedger: () => ({ ledger: ledgerState.ledger }),
}));

function account(id: string, name: string, type: Account['type'], role: Account['role']): Account {
  return { id, name, type, role, archived: false, createdAt: 'x', updatedAt: 'x' };
}

function entry(
  id: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  amount: number,
): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind: 'normal',
    lines: [
      { accountId: debitAccountId, side: 'debit', amount },
      { accountId: creditAccountId, side: 'credit', amount },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };
}

function fixtureLedger(): Ledger {
  return {
    meta: {
      id: 'ledger',
      schemaVersion: SCHEMA_VERSION,
      revision: 1,
      deviceId: 'device',
      createdAt: 'x',
      updatedAt: 'x',
    },
    settings: { ledgerName: 'test', currency: 'JPY', displayFractionDigits: 0 },
    accounts: [
      account('cash', '預金', 'asset', 'daily-asset'),
      account('savings', '貯蓄', 'asset', 'daily-asset'),
      account('equity', '元手', 'equity', 'equity'),
      account('food', '食費', 'expense', 'expense-category'),
      account('salary', '給与', 'revenue', 'income-category'),
    ],
    journalEntries: [
      entry('opening', '2026-01-01', 'cash', 'equity', 1_000_000),
      // 基準日より後の出金・入金・自由資産どうしの振替（純増減 0）。
      entry('outflow', '2026-09-10', 'food', 'cash', 30_000),
      entry('inflow', '2026-09-20', 'cash', 'salary', 50_000),
      entry('transfer', '2026-09-25', 'savings', 'cash', 70_000),
    ],
    monthlyCostItems: [],
    recurringRules: [],
  };
}

function renderCashflow() {
  return render(
    <Cashflow
      period={{ mode: 'date', date: '2026-08-18' }}
      zoom="day"
      onEditEntry={() => undefined}
      onOpenAllocations={() => undefined}
      onOpenAccount={() => undefined}
      onOpenEntry={() => undefined}
    />,
  );
}

/** 未来一覧の金額セル（表示順）。 */
function amountCells(): HTMLElement[] {
  const list = document.querySelector(`[data-ui="${UI.cashflow.futureList}"]`);
  return [...(list?.querySelectorAll<HTMLElement>('.list__amount') ?? [])];
}

/** 金額セルのうち **sr-only を除いた**見える文字列（= 実際に目に入る数字）。 */
function visibleAmountText(cell: HTMLElement): string {
  return [...cell.childNodes]
    .filter((node) => !(node instanceof HTMLElement && node.classList.contains('sr-only')))
    .map((node) => node.textContent ?? '')
    .join('')
    .trim();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 18, 12));
  ledgerState.ledger = fixtureLedger();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  ledgerState.ledger = null;
});

describe('資金繰りのフロー行は符号を付けない（色 + 絶対値 + 言葉）', () => {
  it('出金行は減少色で、見える数字にマイナス符号が無い', () => {
    renderCashflow();
    const cells = amountCells();
    const outflow = cells[0]!;
    expect(outflow.className).toContain('amount--neg');
    // 絶対値そのもの（30_000 minor = 300）。符号は付かない。
    expect(visibleAmountText(outflow)).toBe('300 JPY');
    expect(visibleAmountText(outflow)).not.toMatch(/[-−+]/);
  });

  it('入金行は増加色で、見える数字にプラス符号も付けない', () => {
    renderCashflow();
    const inflow = amountCells()[1]!;
    expect(inflow.className).toContain('amount--pos');
    expect(visibleAmountText(inflow)).toBe('500 JPY');
    expect(visibleAmountText(inflow)).not.toMatch(/[-−+]/);
  });

  it('色だけに頼らない: 金額の手前で方向を言葉で名乗る', () => {
    renderCashflow();
    const cells = amountCells();
    expect(cells[0]?.querySelector('.sr-only')?.textContent).toBe('出金');
    expect(cells[1]?.querySelector('.sr-only')?.textContent).toBe('入金');
    // 自由資産どうしの振替は純増減 0 = 中立色 + 「増減なし」。
    const transfer = cells[2]!;
    expect(transfer.className).toContain('muted');
    expect(transfer.querySelector('.sr-only')?.textContent).toBe('自由に動かせるお金は増減なし');
  });

  it('一覧全体のどこにも矢印・符号の飾りが残っていない', () => {
    renderCashflow();
    for (const cell of amountCells()) {
      expect(visibleAmountText(cell)).not.toMatch(/[-−+→]/);
    }
  });

  it('ストック（上部の自由に動かせるお金）は signed のまま = 符号を消したのはフローだけ', () => {
    renderCashflow();
    const stock = document.querySelector(`[data-ui="${UI.cashflow.summary}"]`);
    // 1_000_000 minor = 10,000 の残高。プラス符号が付く（フロー行とは規約が違う）。
    expect(stock?.textContent).toContain('+10,000 JPY');
  });
});
