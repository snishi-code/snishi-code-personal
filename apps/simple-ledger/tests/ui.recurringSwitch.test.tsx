/*
 * 切り替えシート（v13・作者確定 2026-08-16）:
 *  - 動詞の分離: 「編集 = 全期間を引き直す」に対して「切り替え = この日から別の線」。
 *    導線は行アクション（終了の隣）で、出現条件は終了と同じ。
 *  - シートそのものが確認面（前置きの確認ダイアログは無い）。
 *  - 起票プレビューは切り替え日・起票日・周期に追従する（重複の防波堤はここだけ）。
 *  - 清算パネル = アーカイブシートと同じ 3 点（回収額・回収先・残りの扱い）。
 *    何も選ばなければ持ち物はそれぞれの終了日まで走り切る（settlements を送らない）。
 *  - 終了シートも同じ清算パネルを持ち、保存は switchRecurringRule(successor: null)。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { createRecurringRule, loadLedger } from '../src/data/repository';
import * as repository from '../src/data/repository';
import { deriveRecurringOutputs } from '../src/domain/recurring';
import { ruleItemId } from '../src/domain/recurringIds';
import { LedgerProvider, useLedger } from '../src/state/store';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { Allocations } from '../src/ui/screens/Allocations';
import type { RecurringRule } from '../src/domain/types';
import './setup';

const clock = vi.hoisted(() => ({ today: '2026-08-16' }));

vi.mock('../src/util/time', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/util/time')>();
  return { ...actual, todayLocal: () => clock.today };
});

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
  vi.restoreAllMocks();
  clock.today = '2026-08-16';
});

function View() {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView() {
  const { status } = useLedger();
  return status === 'ready' ? (
    <Allocations period={{ mode: 'date', date: clock.today }} onEditEntry={() => undefined} />
  ) : null;
}

/** 台帳経由（月割り）・毎月 2 日・3,200 円のルール。8/01 から存在する（Claude のプラン）。 */
async function seedRule(
  overrides: Partial<repository.RecurringRuleInput> = {},
): Promise<RecurringRule> {
  const ledger = await loadLedger();
  const bank = ledger.accounts.find((account) => account.name === '預金')!;
  const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
  return createRecurringRule({
    name: 'Claude',
    amount: 320_000,
    dayOfMonth: 2,
    everyMonths: 1,
    debitAccountId: fixed.id,
    spreadViaLedger: true,
    creditAccountId: bank.id,
    startMonth: '2026-08',
    startDate: '2026-08-01',
    ...overrides,
  });
}

function q(dataUi: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-ui="${dataUi}"]`);
}

function input(dataUi: string): HTMLInputElement {
  return q(dataUi) as HTMLInputElement;
}

/** 出現を待って引く（waitFor のコールバックは throw で再試行するので expect を挟む）。 */
async function find(dataUi: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = q(dataUi);
    expect(found).toBeTruthy();
    return found!;
  });
}

function setValue(dataUi: string, value: string): void {
  fireEvent.change(input(dataUi), { target: { value } });
}

/** 清算パネルの 1 行（導出 item の決定的 ID で引く）。 */
function settlementRow(itemId: string): HTMLElement {
  return document.querySelector<HTMLElement>(
    `[data-ui="${UI.allocations.recurringSettlementItem}"][data-item-id="${itemId}"]`,
  )!;
}

function radioIn(row: HTMLElement, dataUi: string): HTMLInputElement {
  return row.querySelector<HTMLInputElement>(`[data-ui="${dataUi}"]`)!;
}

async function openSwitchSheet(): Promise<void> {
  render(<View />);
  fireEvent.click(await find(UI.allocations.recurringSwitch));
  await find(UI.allocations.recurringSwitchSheet);
}

describe('切り替えシートの導線と既定値', () => {
  it('行アクションから開き、既定は今日 + 現在のルール値', async () => {
    const rule = await seedRule();
    render(<View />);

    const switchButton = await find(UI.allocations.recurringSwitch);
    expect(switchButton).toHaveAttribute('aria-label', `切り替え: ${rule.name}`);
    // 終了の隣に並ぶ（出現条件は同じ）。
    expect(q(UI.allocations.recurringEnd)).toBeInTheDocument();
    // 開くまでは何も保存しない。
    expect((await loadLedger()).recurringRules).toHaveLength(1);

    fireEvent.click(switchButton);
    expect(q(UI.allocations.recurringSwitchSheet)).toBeInTheDocument();
    expect(input(UI.allocations.recurringSwitchDate)).toHaveValue('2026-08-16');
    expect(input(UI.allocations.recurringSwitchAmount)).toHaveValue('3200');
    expect(input(UI.allocations.recurringSwitchDayOfMonth)).toHaveValue('2');
    expect(input(UI.allocations.recurringSwitchEvery)).toHaveValue('1');
  });

  it('起票プレビューは切り替え日・起票日の変更に追従する', async () => {
    await seedRule();
    await openSwitchSheet();

    // 既定（8/16 から・毎月 2 日）では初回起票は翌月の 2 日。
    const preview = q(UI.allocations.recurringSwitchPreview)!;
    expect(preview).toHaveTextContent('現在のルールは 2026-08-16 より前までです。');
    expect(preview).toHaveTextContent('新しい条件の初回の起票は 2026-09-02 です。');

    setValue(UI.allocations.recurringSwitchDate, '2026-08-10');
    setValue(UI.allocations.recurringSwitchDayOfMonth, '10');
    expect(preview).toHaveTextContent('現在のルールは 2026-08-10 より前までです。');
    // 切り替え日当日の起票は後継が担当する（半開区間）。
    expect(preview).toHaveTextContent('新しい条件の初回の起票は 2026-08-10 です。');

    // 存在期間に起票日が来ない周期では「起票されません」を明示する（fail-closed の予告）。
    setValue(UI.allocations.recurringSwitchEvery, '');
    expect(preview).not.toHaveTextContent('初回の起票は');
  });
});

describe('清算パネル', () => {
  it('既定は「そのまま使い切る」で回収欄を出さず、「この日で終える」で 3 点が出る', async () => {
    const rule = await seedRule();
    await openSwitchSheet();
    setValue(UI.allocations.recurringSwitchDate, '2026-08-10');

    const row = settlementRow(ruleItemId(rule.id, '2026-08'));
    expect(row).toBeTruthy();
    expect(row).toHaveTextContent('2026-08-02 〜 2026-09-02');
    expect(radioIn(row, UI.allocations.recurringSettlementKeep).checked).toBe(true);
    expect(
      row.querySelector(`[data-ui="${UI.allocations.recurringSettlementRecoveryAmount}"]`),
    ).toBeNull();

    fireEvent.click(radioIn(row, UI.allocations.recurringSettlementEnd));
    // 回収額の既定 = 切り替え日時点の残存価値。回収先は 0 でない間だけ出る。
    const recovery = row.querySelector<HTMLInputElement>(
      `[data-ui="${UI.allocations.recurringSettlementRecoveryAmount}"]`,
    )!;
    expect(recovery).toHaveValue('3200');
    expect(
      row.querySelector(`[data-ui="${UI.allocations.recurringSettlementRecoveryTo}"]`),
    ).toBeTruthy();
    expect(
      row.querySelector(`[data-ui="${UI.allocations.recurringSettlementRemainder}"]`),
    ).toBeTruthy();

    fireEvent.change(recovery, { target: { value: '0' } });
    expect(
      row.querySelector(`[data-ui="${UI.allocations.recurringSettlementRecoveryTo}"]`),
    ).toBeNull();
  });

  it('回収額の既定は切り替え日に追従し、手で直したら追従を止める', async () => {
    // 年払い（12 か月ごと・12,000 円）: item は [8/02, 翌 8/02] の 12 刻みなので、
    // 切り替え日を動かすと残存価値が実際に変わる。
    const rule = await seedRule({ amount: 1_200_000, everyMonths: 12 });
    await openSwitchSheet();
    const itemId = ruleItemId(rule.id, '2026-08');
    fireEvent.click(radioIn(settlementRow(itemId), UI.allocations.recurringSettlementEnd));

    const recoveryInput = (): HTMLInputElement =>
      settlementRow(itemId).querySelector<HTMLInputElement>(
        `[data-ui="${UI.allocations.recurringSettlementRecoveryAmount}"]`,
      )!;
    expect(recoveryInput().value).toBe('12000');

    // 既定のままなら追従する（10/05 時点では 9/02・10/02 の 2 刻みが済んでいる）。
    setValue(UI.allocations.recurringSwitchDate, '2026-10-05');
    expect(recoveryInput().value).toBe('10000');

    // 手で直してあればその値を尊重する（判定はフラグではなく値）。
    fireEvent.change(recoveryInput(), { target: { value: '2478' } });
    setValue(UI.allocations.recurringSwitchDate, '2026-08-16');
    expect(recoveryInput().value).toBe('2478');
  });
});

describe('保存', () => {
  it('切り替え + 清算を 1 回の switchRecurringRule で送る', async () => {
    const rule = await seedRule();
    const bank = (await loadLedger()).accounts.find((account) => account.name === '預金')!;
    const save = vi.spyOn(repository, 'switchRecurringRule');
    await openSwitchSheet();

    setValue(UI.allocations.recurringSwitchDate, '2026-08-10');
    setValue(UI.allocations.recurringSwitchAmount, '35200');
    setValue(UI.allocations.recurringSwitchDayOfMonth, '10');

    const itemId = ruleItemId(rule.id, '2026-08');
    fireEvent.click(radioIn(settlementRow(itemId), UI.allocations.recurringSettlementEnd));
    fireEvent.change(
      settlementRow(itemId).querySelector(
        `[data-ui="${UI.allocations.recurringSettlementRecoveryAmount}"]`,
      )!,
      { target: { value: '2478' } },
    );
    fireEvent.click(
      within(
        settlementRow(itemId).querySelector<HTMLElement>(
          `[data-ui="${UI.allocations.recurringSettlementRecoveryTo}"]`,
        )!,
      ).getByRole('radio', { name: bank.name }),
    );
    fireEvent.click(q(UI.allocations.recurringSwitchConfirm)!);

    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    expect(save).toHaveBeenCalledWith({
      ruleId: rule.id,
      effectiveDate: '2026-08-10',
      successor: { amount: 3_520_000, dayOfMonth: 10, everyMonths: 1 },
      settlements: [
        {
          ruleId: rule.id,
          month: '2026-08',
          recoveries: [{ destinationAccountId: bank.id, amount: 247_800 }],
        },
      ],
    });
    // 保存後はシートが閉じ、導出に旧プランと新プランが並ぶ。
    await waitFor(() => {
      expect(q(UI.allocations.recurringSwitchSheet)).toBeNull();
    });
    const after = await loadLedger();
    expect(
      deriveRecurringOutputs(after.recurringRules, after.accounts, '2026-08-31')
        .entries.map((entry) => `${entry.date}:${entry.lines[0]!.amount}`)
        .sort(),
    ).toEqual(['2026-08-02:320000', '2026-08-10:3520000']);
  });

  it('清算を選ばなければ settlements を送らない（持ち物は自分の終了日まで走り切る）', async () => {
    const rule = await seedRule();
    const save = vi.spyOn(repository, 'switchRecurringRule');
    await openSwitchSheet();

    fireEvent.click(q(UI.allocations.recurringSwitchConfirm)!);

    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    expect(save).toHaveBeenCalledWith({
      ruleId: rule.id,
      effectiveDate: '2026-08-16',
      successor: { amount: 320_000, dayOfMonth: 2, everyMonths: 1 },
    });
    const after = await loadLedger();
    expect(
      deriveRecurringOutputs(after.recurringRules, after.accounts, '2026-08-31').items.map(
        (item) => item.endDate,
      ),
    ).toEqual(['2026-09-02']);
  });
});

describe('終了シートの清算', () => {
  it('同じ清算パネルを持ち、保存は switchRecurringRule(successor: null)', async () => {
    const rule = await seedRule();
    const bank = (await loadLedger()).accounts.find((account) => account.name === '預金')!;
    const save = vi.spyOn(repository, 'switchRecurringRule');
    render(<View />);

    fireEvent.click(await find(UI.allocations.recurringEnd));
    await find(UI.allocations.recurringEndSheet);
    expect(input(UI.allocations.recurringEndSheetDate)).toHaveValue('2026-08-16');

    const itemId = ruleItemId(rule.id, '2026-08');
    fireEvent.click(radioIn(settlementRow(itemId), UI.allocations.recurringSettlementEnd));
    fireEvent.click(
      within(
        settlementRow(itemId).querySelector<HTMLElement>(
          `[data-ui="${UI.allocations.recurringSettlementRecoveryTo}"]`,
        )!,
      ).getByRole('radio', { name: bank.name }),
    );
    fireEvent.click(q(UI.allocations.recurringEndSheetConfirm)!);

    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    expect(save).toHaveBeenCalledWith({
      ruleId: rule.id,
      effectiveDate: '2026-08-16',
      successor: null,
      settlements: [
        {
          ruleId: rule.id,
          month: '2026-08',
          recoveries: [{ destinationAccountId: bank.id, amount: 320_000 }],
        },
      ],
    });
    const after = await loadLedger();
    expect(after.recurringRules).toHaveLength(1);
    expect(after.recurringRules[0]!.endDate).toBe('2026-08-16');
    expect(after.recurringRules[0]!.settlements).toEqual([
      { month: '2026-08', endDate: '2026-08-16' },
    ]);
  });
});
