/*
 * 月割り台帳の today 規約（v13.12 項目 1）:
 *  - 表示・操作可否は実 today ではなく**ヘッダー断面（asOf）**へ追従する。
 *  - 切替/終了ボタンは「asOf 時点で存在し、終了点が未設定」なら出す
 *    （半開区間そのまま = 開始日 = 断面当日も含む。旧 `start < today` の当日非表示を解消）。
 *  - 編集シートの起票数の予告（引き直し・カスケード削除）も断面までの導出数。
 * 実 today（clock.today = 2026-08-16）と異なる断面を渡して検証する = 実装を today 基準へ
 * 戻すとこのファイルが落ちる（mutation check）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { createRecurringRule, loadLedger } from '../src/data/repository';
import type { RecurringRuleInput } from '../src/data/repository';
import { LedgerProvider, useLedger } from '../src/state/store';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { Allocations } from '../src/ui/screens/Allocations';
import { firstRuleRow } from './tapTargets';
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

function View({ date }: { date: string }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView date={date} />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView({ date }: { date: string }) {
  const { status } = useLedger();
  return status === 'ready' ? (
    <Allocations period={{ mode: 'date', date }} onEditEntry={() => undefined} />
  ) : null;
}

async function seedRule(overrides: Partial<RecurringRuleInput> = {}) {
  const ledger = await loadLedger();
  const bank = ledger.accounts.find((account) => account.name === '預金')!;
  const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
  return createRecurringRule({
    name: 'Claude',
    amount: 320_000,
    dayOfMonth: 5,
    everyMonths: 1,
    debitAccountId: fixed.id,
    creditAccountId: bank.id,
    startMonth: '2026-09',
    startDate: '2026-09-05',
    ...overrides,
  });
}

function q(dataUi: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-ui="${dataUi}"]`);
}

async function renderAt(date: string) {
  const view = render(<View date={date} />);
  await waitFor(() => {
    expect(q(UI.allocations.view)).toBeInTheDocument();
  });
  return view;
}

describe('切替/終了ボタンはヘッダー断面（asOf）基準（v13.12 項目 1）', () => {
  it('開始日 = 断面当日のルールにボタンが出る（実 today は開始前でも）', async () => {
    // clock.today = 2026-08-16 の時点では未開始。断面を開始日当日へ振ると操作できる。
    await seedRule();
    await renderAt('2026-09-05');
    await waitFor(() => {
      expect(q(UI.allocations.recurringSwitch)).toBeInTheDocument();
    });
    expect(q(UI.allocations.recurringEnd)).toBeInTheDocument();
    expect(q(UI.allocations.recurringStatus)).toBeNull();
  });

  it('断面が開始前ならルール行そのものが出ない（実 today ではなく asOf で判定）', async () => {
    await seedRule({ startMonth: '2026-08', startDate: '2026-08-05' });
    // 実 today（8/16）は開始後だが、断面 8/01 ではまだ存在しない。
    await renderAt('2026-08-01');
    expect(q(UI.allocations.recurringList)).toBeNull();
  });

  it('終了点を持つルールの状態チップは断面に追従する（存在中 = 「まで」・後 = 終了済み）', async () => {
    await seedRule({
      startMonth: '2026-08',
      startDate: '2026-08-05',
      endDate: '2026-10-01',
    });
    // 断面 = 存在期間の内側: ボタンは出さず（終了点あり）「いつまで動くか」を名乗る。
    const view = await renderAt('2026-09-01');
    await waitFor(() => {
      expect(q(UI.allocations.recurringStatus)).toHaveTextContent('2026-09-30 まで');
    });
    expect(q(UI.allocations.recurringEnd)).toBeNull();

    // 断面を終了後へ: 既定では消え、「終了分も表示」で終了済みチップ。
    // 実 today（8/16）基準なら存在中 = 「まで」のままになるはず（mutation check）。
    view.rerender(<View date="2026-11-01" />);
    await waitFor(() => {
      expect(q(UI.allocations.recurringList)).toBeNull();
    });
    fireEvent.click(q(UI.allocations.showCompleted)!);
    await waitFor(() => {
      expect(q(UI.allocations.recurringStatus)).toHaveTextContent('終了済み');
    });
  });
});

describe('編集シートの起票数の予告は断面までの導出数（v13.12 項目 1）', () => {
  it('引き直しの予告とカスケード削除の確認が asOf までの件数を名乗る', async () => {
    // 1/05 開始・毎月 5 日起票。断面 3/15 までの起票 = 1月・2月・3月の 3 件
    // （実 today 8/16 基準なら 8 件になるはず = mutation check）。
    await seedRule({ startMonth: '2026-01', startDate: '2026-01-05' });
    await renderAt('2026-03-15');
    await waitFor(() => {
      expect(firstRuleRow()).not.toBeNull();
    });
    fireEvent.click(firstRuleRow()!);
    await waitFor(() => {
      expect(q(UI.allocations.recurringSheet)).toBeInTheDocument();
    });
    expect(q(UI.allocations.recurringEditRetroactiveNote)).toHaveTextContent(
      '過去 3 回の起票が引き直されます',
    );

    fireEvent.click(q(UI.allocations.recurringDelete)!);
    await waitFor(() => {
      expect(document.body.textContent).toContain('3 回分の仕訳と持ち物も一緒に消えます');
    });
  });
});
