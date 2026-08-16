/*
 * 「毎月のもの」の検索・並び替え（実ユーズレビュー 2026-08-12 ①）:
 *  - 検索欄 1 つ・並び替え 1 組が定期ルールと継続コスト資産の両セクションへ同時に効く
 *  - 軸は仕訳一覧と同じ語彙の「日付 / 金額 / 名称」。日付の意味だけがセクションごとに違う
 *    （継続コスト資産 = 終了日 / 定期ルール = 開始日）
 *  - 既定 = 日付・昇順（継続コスト資産は従来どおり終了が近い順に見える）
 *  - どの軸でも方向を選べる。日付軸では終了日なしが昇降どちらでも最後に留まる
 *  - 軸切替で方向は軸ごとの既定へ戻る
 *  - ルール由来（ccr-）item は「くり返し記帳から」を名乗る
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Allocations, type AllocationsTarget } from '../src/ui/screens/Allocations';
import { createContinuousCost, createRecurringRule, loadLedger } from '../src/data/repository';
import { addMonthsToDate } from '../src/domain/allocation';
import type { ReportPeriod } from '../src/domain/reportPeriod';
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

function View({ period, target }: { period: ReportPeriod; target?: AllocationsTarget | null }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView period={period} target={target ?? null} />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView({ period, target }: { period: ReportPeriod; target: AllocationsTarget | null }) {
  const { status } = useLedger();
  return status === 'ready' ? (
    <Allocations period={period} onEditEntry={() => undefined} target={target} />
  ) : null;
}

async function renderReady(target?: AllocationsTarget | null) {
  const view = render(<View period={{ mode: 'all' }} target={target} />);
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).toBeInTheDocument();
  });
  return view;
}

/** 3 item + 2 rule の共通 fixture。戻り値 = 期待する既定順の名前。 */
async function seed() {
  const ledger = await loadLedger();
  const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
  const bank = ledger.accounts.find((a) => a.name === '預金')!;
  const invest = ledger.accounts.find((a) => a.name === '投資')!;
  const today = todayLocal();
  // 終了が近い順に「もうすぐ終了(3000)」→「まだ先(1000)」→「終了日なし(2000)」となる 3 件。
  await createContinuousCost({
    name: 'もうすぐ終了',
    amount: 3000,
    startDate: '2026-01-01',
    endDate: addMonthsToDate(today, 1),
    expenseAccountId: expense.id,
  });
  await createContinuousCost({
    name: 'まだ先',
    amount: 1000,
    startDate: '2026-01-01',
    endDate: addMonthsToDate(today, 12),
    expenseAccountId: expense.id,
  });
  await createContinuousCost({
    name: '終了日なし',
    amount: 2000,
    startDate: '2026-01-01',
    expenseAccountId: expense.id,
  });
  // 定期ルール。v13.1（c 案）で全ルールが台帳経由になり、起票が到来すると導出 item が
  // item セクションへ並んでしまうため、位相（startMonth）を翌月に置いて起票を未到来にする
  // ＝この fixture の item セクションは継続コスト資産 3 件だけになる。
  // 開始日を変えて日付軸の順を確かめられるようにする
  // （さきの積立 = 3ヶ月前 → あとの積立 = 今日。名称順・金額順とは別の並びになる）。
  const nextMonth = addMonthsToDate(today, 1).slice(0, 7);
  await createRecurringRule({
    name: 'さきの積立',
    amount: 200,
    dayOfMonth: 1,
    debitAccountId: invest.id,
    creditAccountId: bank.id,
    startMonth: nextMonth,
    startDate: addMonthsToDate(today, -3),
  });
  await createRecurringRule({
    name: 'あとの積立',
    amount: 100,
    dayOfMonth: 1,
    debitAccountId: invest.id,
    creditAccountId: bank.id,
    startMonth: nextMonth,
    startDate: today,
  });
  return { expense, bank, invest };
}

function itemNames(): string[] {
  return [...document.querySelectorAll(`[data-ui="${UI.allocations.item}"] .list__title`)].map(
    (el) => (el.textContent ?? '').trim(),
  );
}

function ruleNames(): string[] {
  return [
    ...document.querySelectorAll(`[data-ui="${UI.allocations.recurringList}"] .list__title`),
  ].map((el) => (el.textContent ?? '').trim());
}

function search(value: string) {
  fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.search}"]`)!, {
    target: { value },
  });
}

describe('毎月のものの検索', () => {
  it('登録が 1 件も無いときは検索・並び替えを描画しない', async () => {
    await renderReady();
    expect(document.querySelector(`[data-ui="${UI.allocations.search}"]`)).toBeNull();
    expect(document.querySelector(`[data-ui="${UI.allocations.sortByDate}"]`)).toBeNull();
  });

  it('1 つの検索欄が両セクションへ同時に効き、計上先・貸方/行き先の科目名でも当たる', async () => {
    const { expense, invest } = await seed();
    await renderReady();
    await screen.findByText('もうすぐ終了');

    // 項目名: item だけが残り、非一致の定期ルールセクションは丸ごと消える。
    search('もうすぐ');
    expect(itemNames()).toEqual(expect.arrayContaining([expect.stringContaining('もうすぐ終了')]));
    expect(itemNames()).toHaveLength(1);
    expect(document.querySelector(`[data-ui="${UI.allocations.recurringList}"]`)).toBeNull();

    // ルール名: 逆に item セクションが消える。
    search('さきの積立');
    expect(document.querySelector(`[data-ui="${UI.allocations.list}"]`)).toBeNull();
    expect(ruleNames()).toHaveLength(1);

    // 計上先の科目名で item がヒットする。
    search(expense.name);
    expect(itemNames()).toHaveLength(3);

    // 行き先の科目名で定期ルールがヒットする。
    search(invest.name);
    expect(ruleNames()).toHaveLength(2);

    // 空へ戻すと全件へ戻る。
    search('');
    expect(itemNames()).toHaveLength(3);
    expect(ruleNames()).toHaveLength(2);
  });

  it('全件不一致では「該当なし」カードを 1 枚だけ出し、既存の案内文と排他にする', async () => {
    await seed();
    await renderReady();
    await screen.findByText('もうすぐ終了');
    search('存在しない語');
    const empty = document.querySelectorAll(`[data-ui="${UI.allocations.searchEmpty}"]`);
    expect(empty).toHaveLength(1);
    expect(empty[0]).toHaveTextContent(t('monthly.searchEmpty'));
    // データ無しの案内文（monthly.empty）は同時に出ない。
    expect(screen.queryByText(/「追加」から/)).toBeNull();
    expect(document.querySelector(`[data-ui="${UI.allocations.list}"]`)).toBeNull();
    expect(document.querySelector(`[data-ui="${UI.allocations.recurringList}"]`)).toBeNull();
  });

  it('検索語が入ったまま target 遷移すると検索欄が空になり、シートが開く', async () => {
    await seed();
    const ledger = await loadLedger();
    const item = ledger.monthlyCostItems.find((m) => m.name === 'まだ先')!;
    const { rerender } = await renderReady();
    await screen.findByText('もうすぐ終了');
    search('もうすぐ');
    expect(itemNames()).toHaveLength(1);

    rerender(<View period={{ mode: 'all' }} target={{ itemId: item.id }} />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.editDialog}"]`)).not.toBeNull();
    });
    expect(
      (document.querySelector(`[data-ui="${UI.allocations.search}"]`) as HTMLInputElement).value,
    ).toBe('');
  });
});

// タイトルには種別タグ・由来タグの文字列が続くため、名前の頭 5 文字だけで並びを比べる
// （fixture の名前は先頭 5 文字で一意に決まる）。
function itemHeads(): string[] {
  return itemNames().map((s) => s.slice(0, 5));
}

function ruleHeads(): string[] {
  return ruleNames().map((s) => s.slice(0, 5));
}

describe('毎月のものの並び替え', () => {
  it('既定は日付・昇順で、継続コスト資産は終了が近い順・定期ルールは開始日順になる', async () => {
    await seed();
    await renderReady();
    await screen.findByText('もうすぐ終了');
    // 継続コスト資産の日付 = 終了日。終了日なしは最後。
    expect(itemHeads()).toEqual(['もうすぐ終', 'まだ先', '終了日なし']);
    // 定期ルールの日付 = 開始日（3ヶ月前 → 今日）。
    expect(ruleHeads()).toEqual(['さきの積立', 'あとの積立']);
    // 方向トグルはどの軸でも出る（「標準」軸の特別扱いは無い）。
    expect(document.querySelector(`[data-ui="${UI.allocations.sortDesc}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-ui="${UI.allocations.sortAsc}"]`)).not.toBeNull();
  });

  it('日付軸の昇降で両セクションが反転し、終了日なしは降順でも最後に留まる', async () => {
    await seed();
    await renderReady();
    await screen.findByText('もうすぐ終了');

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.sortDesc}"]`)!);
    // 終了日を持つ 2 件だけが反転し、終了日なしは最後のまま。
    expect(itemHeads()).toEqual(['まだ先', 'もうすぐ終', '終了日なし']);
    expect(ruleHeads()).toEqual(['あとの積立', 'さきの積立']);

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.sortAsc}"]`)!);
    expect(itemHeads()).toEqual(['もうすぐ終', 'まだ先', '終了日なし']);
    expect(ruleHeads()).toEqual(['さきの積立', 'あとの積立']);
  });

  it('金額・名称の軸が両セクションへ効き、日付へ戻すと既定の並びへ戻る', async () => {
    await seed();
    await renderReady();
    await screen.findByText('もうすぐ終了');
    const defaultItems = itemNames();
    const defaultRules = ruleNames();

    // 金額（既定 = 降順）。
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.sortByAmount}"]`)!);
    expect(itemHeads()).toEqual(['もうすぐ終', '終了日なし', 'まだ先']);
    expect(ruleHeads()[0]).toBe('さきの積立'); // 200 > 100

    // 昇順へ切り替え。
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.sortAsc}"]`)!);
    expect(itemNames().map((s) => s.slice(0, 3))).toEqual(['まだ先', '終了日', 'もうす']);
    expect(ruleHeads()[0]).toBe('あとの積立');

    // 名称（既定 = 昇順・五十音）。
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.sortByName}"]`)!);
    expect(ruleHeads()[0]).toBe('あとの積立');

    // 日付へ戻すと方向も日付の既定（昇順）へ戻り、両セクションとも既定の並びへ復帰する。
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.sortByDate}"]`)!);
    expect(itemNames()).toEqual(defaultItems);
    expect(ruleNames()).toEqual(defaultRules);

    // 再び金額を押すと方向は既定（降順）へ戻っている（昇順が残らない）。
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.sortByAmount}"]`)!);
    expect(itemNames()[0]).toContain('もうすぐ終了');
  });
});

describe('ルール由来 item の由来表示', () => {
  it('ccr- 由来の item に「くり返し記帳から」のタグが付く', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const today = todayLocal();
    // 費用行きのルール（過去開始）→ catch-up が ccr- item を自動生成する。
    await createRecurringRule({
      name: 'サブスク自動',
      amount: 500,
      dayOfMonth: 1,
      debitAccountId: expense.id,
      creditAccountId: bank.id,
      startMonth: today.slice(0, 7),
      startDate: `${today.slice(0, 7)}-01`,
    });
    await renderReady();
    // catch-up（Provider 初期化）で当月ぶんの ccr- item が生成されるのを待つ。
    await waitFor(() => {
      expect(
        document.querySelectorAll(`[data-ui="${UI.allocations.item}"]`).length,
      ).toBeGreaterThan(0);
    });
    const tagged = [...document.querySelectorAll(`[data-ui="${UI.allocations.item}"]`)].filter(
      (card) => (card.textContent ?? '').includes(t('monthlyCost.fromRule')),
    );
    expect(tagged.length).toBeGreaterThan(0);
  });
});
