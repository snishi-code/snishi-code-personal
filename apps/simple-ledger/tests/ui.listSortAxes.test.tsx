/*
 * 並び替え軸の正本が共有されていることの検査（実ユーズ指摘「統一されていない」の再発防止）。
 * 仕訳一覧と「毎月のもの」の軸 Segmented に実際に出る軸（data-ui の末尾 = 軸 key と表示ラベル）が
 * LIST_SORT_AXES と完全に一致することを DOM から見る。
 * どちらか一方の画面にだけ軸を足す/文言をずらす（＝別コードを書く）と落ちる。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Journal } from '../src/ui/screens/Journal';
import { Allocations } from '../src/ui/screens/Allocations';
import { createContinuousCost, loadLedger } from '../src/data/repository';
import { addMonthsToDate } from '../src/domain/allocation';
import { LIST_SORT_AXES } from '../src/ui/ListSearchSort';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { t } from '../src/i18n';
import { todayLocal } from '../src/util/time';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

/** 軸の Segmented（.list-sort の 1 本目）に出ているボタン。方向の Segmented は含めない。 */
function axisButtons(): HTMLElement[] {
  const axisGroup = document.querySelector('.list-sort .segmented');
  expect(axisGroup).not.toBeNull();
  return Array.from(axisGroup!.querySelectorAll('button'));
}

/** data-ui は画面ごとに接頭辞が違う（journal.sort.* / allocations.sort.*）ので末尾だけを見る。 */
function axisKeysFromDom(): string[] {
  return axisButtons().map((el) => (el.getAttribute('data-ui') ?? '').split('.').pop() ?? '');
}

function axisLabelsFromDom(): string[] {
  return axisButtons().map((el) => (el.textContent ?? '').trim());
}

const EXPECTED_KEYS = LIST_SORT_AXES.map((axis) => axis.key);
const EXPECTED_LABELS = LIST_SORT_AXES.map((axis) => t(axis.labelKey));

function JournalView() {
  const { status } = useLedger();
  if (status !== 'ready') return null;
  return (
    <Journal
      onEditEntry={() => undefined}
      onReverse={() => undefined}
      onOpenAllocations={() => undefined}
      onOpenAccount={() => undefined}
      filter={null}
      period={{ mode: 'all' }}
      onClearFilter={() => undefined}
    />
  );
}

function AllocationsView() {
  const { status } = useLedger();
  if (status !== 'ready') return null;
  return <Allocations period={{ mode: 'all' }} onEditEntry={() => undefined} target={null} />;
}

describe('並び替え軸の正本共有', () => {
  it('軸の正本は 日付 / 金額 / 名称 の 3 つ（両画面が参照する唯一の定義）', () => {
    expect(EXPECTED_KEYS).toEqual(['date', 'amount', 'name']);
    expect(EXPECTED_LABELS).toEqual(['日付', '金額', '名称']);
  });

  it('仕訳一覧の軸が LIST_SORT_AXES と一致する', async () => {
    render(
      <ToastProvider>
        <LedgerProvider>
          <JournalView />
        </LedgerProvider>
      </ToastProvider>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.view}"]`)).toBeInTheDocument();
    });

    expect(axisKeysFromDom()).toEqual(EXPECTED_KEYS);
    expect(axisLabelsFromDom()).toEqual(EXPECTED_LABELS);
  });

  it('毎月のものの軸が LIST_SORT_AXES と一致する', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    // 並び替えは登録が 1 件以上あるときだけ描画されるため、item を 1 件だけ用意する。
    await createContinuousCost({
      name: '軸の検査',
      amount: 1000,
      startDate: '2026-01-01',
      endDate: addMonthsToDate(todayLocal(), 6),
      expenseAccountId: expense.id,
    });

    render(
      <ToastProvider>
        <LedgerProvider>
          <AllocationsView />
        </LedgerProvider>
      </ToastProvider>,
    );
    await screen.findByText('軸の検査');

    expect(axisKeysFromDom()).toEqual(EXPECTED_KEYS);
    expect(axisLabelsFromDom()).toEqual(EXPECTED_LABELS);
  });
});
