/*
 * 定期ルールシートのレイアウト（v13.1 その4・作者確定 2026-08-16）:
 *  - フィールド順 = 初回の起票日 → 周期 → 摘要 → 金額 → 貸方→借方（FlowField）→
 *    プレビュー（初回の起票）。存在期間（開始日・終了日）は詳細の折りたたみで、
 *    新規作成では出さない（開始 = 初回の起票日で自動）
 *  - 編集ではプレビューの下へ「過去 N 回の起票が引き直されます」の予告が付く
 *    （編集 = 全期間・「切替」との使い分けを学べる）
 *  - 貸方/借方はホームの簿記編集と同じ flat チップ（グループ見出しを出さない・作者決定）
 *  - 「初回の起票」プレビューは保存値と同じ規則で導出し、入力が不正な間は行ごと消える
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Allocations } from '../src/ui/screens/Allocations';
import { createRecurringRule, loadLedger } from '../src/data/repository';
import type { ReportPeriod } from '../src/domain/reportPeriod';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { t } from '../src/i18n';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function View({ period }: { period: ReportPeriod }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView period={period} />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView({ period }: { period: ReportPeriod }) {
  const { status } = useLedger();
  return status === 'ready' ? <Allocations period={period} onEditEntry={() => undefined} /> : null;
}

async function openRuleSheet() {
  render(<View period={{ mode: 'all' }} />);
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).toBeInTheDocument();
  });
  fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
  fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.rule"]`)!);
  const sheet = document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`);
  expect(sheet).not.toBeNull();
  return sheet as HTMLElement;
}

/** 既存ルールを 1 本作って編集シートを開く（詳細の折りたたみを検証する用）。 */
async function openEditSheet() {
  const ledger = await loadLedger();
  const bank = ledger.accounts.find((account) => account.role === 'daily-asset')!;
  const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
  const rule = await createRecurringRule({
    name: 'レイアウト編集対象',
    amount: 100000,
    dayOfMonth: 10,
    everyMonths: 3,
    debitAccountId: expense.id,
    creditAccountId: bank.id,
    startMonth: '2026-01',
    startDate: '2026-01-01',
  });
  render(<View period={{ mode: 'all' }} />);
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).toBeInTheDocument();
  });
  fireEvent.click((await screen.findAllByRole('button', { name: `編集: ${rule.name}` }))[0]!);
  const sheet = document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`);
  expect(sheet).not.toBeNull();
  return { sheet: sheet as HTMLElement, rule };
}

function setValue(dataUi: string, value: string) {
  fireEvent.change(document.querySelector(`[data-ui="${dataUi}"]`)!, { target: { value } });
}

/**
 * 「初回の起票」の視覚行の中身。視覚行は値があるときだけ描画される（空の枠を残さない）。
 * 読み上げは別の常設 sr-only status（recurringFirstPostingStatus）が担う。
 */
function previewText(): string {
  const row = document.querySelector(`[data-ui="${UI.allocations.recurringFirstPosting}"]`);
  return row ? (row.textContent ?? '').trim() : '';
}

/** 常設 sr-only status の中身（live region はマウント後に effect が流し込む）。 */
function statusText(): string {
  const status = document.querySelector(
    `[data-ui="${UI.allocations.recurringFirstPostingStatus}"]`,
  );
  expect(status, '読み上げ用 status は常設であること').not.toBeNull();
  expect(status).toHaveAttribute('role', 'status');
  return (status?.textContent ?? '').trim();
}

describe('定期ルールシートのレイアウト', () => {
  it('新規: フィールドが作者指定の順に並び、存在期間の欄は出ない（開始 = 初回の起票日）', async () => {
    const sheet = await openRuleSheet();
    const order = [...sheet.querySelectorAll('[data-ui^="allocations.recurring."]')].map((el) =>
      el.getAttribute('data-ui'),
    );
    expect(order).toEqual([
      UI.allocations.recurringFirstPostingDate,
      UI.allocations.recurringEvery,
      UI.allocations.recurringName,
      UI.allocations.recurringAmount,
      UI.allocations.recurringFlow,
      UI.allocations.recurringFrom,
      UI.allocations.recurringTo,
      UI.allocations.recurringFirstPosting,
      UI.allocations.recurringFirstPostingStatus,
      UI.allocations.recurringSave,
    ]);
  });

  it('編集: 存在期間は詳細の折りたたみに入り、最下部に解除（終了済みのみ）と削除が並ぶ', async () => {
    const { sheet } = await openEditSheet();
    // 折りたたみが閉じている間、存在期間の欄は無い。
    expect(sheet.querySelector(`[data-ui="${UI.allocations.recurringStartDate}"]`)).toBeNull();
    fireEvent.click(sheet.querySelector(`[data-ui="${UI.allocations.recurringDetailsToggle}"]`)!);
    const order = [...sheet.querySelectorAll('[data-ui^="allocations.recurring."]')].map((el) =>
      el.getAttribute('data-ui'),
    );
    expect(order).toEqual([
      UI.allocations.recurringFirstPostingDate,
      UI.allocations.recurringEvery,
      UI.allocations.recurringName,
      UI.allocations.recurringAmount,
      UI.allocations.recurringFlow,
      UI.allocations.recurringFrom,
      UI.allocations.recurringTo,
      UI.allocations.recurringFirstPosting,
      UI.allocations.recurringEditRetroactiveNote,
      UI.allocations.recurringFirstPostingStatus,
      UI.allocations.recurringDetailsToggle,
      UI.allocations.recurringStartDate,
      UI.allocations.recurringEndDate,
      UI.allocations.recurringDelete,
      UI.allocations.recurringSave,
    ]);
    // 終了していないルールに「終了日を解除」は出ない。
    expect(sheet.querySelector(`[data-ui="${UI.allocations.recurringClearEndDate}"]`)).toBeNull();
  });

  it('編集: 「過去 N 回の起票が引き直されます」の予告を出す（切替との使い分け）', async () => {
    await openEditSheet();
    const note = document.querySelector(
      `[data-ui="${UI.allocations.recurringEditRetroactiveNote}"]`,
    );
    expect(note).not.toBeNull();
    // 2026-01-10 起点・3 か月ごと・今日（実クロック）までの起票数は 1 以上であることだけを見る
    //（値そのものは deriveRecurringOutputs の領分。ここは表示の存在と文言）。
    expect(note!.textContent).toMatch(/過去 \d+ 回の起票が引き直されます/);
    expect(note!.textContent).toContain('切替');
  });

  it('貸方・借方はホームと同じ flat チップ（グループ見出しの role="group" を出さない）', async () => {
    await openRuleSheet();
    const from = document.querySelector<HTMLElement>(`[data-ui="${UI.allocations.recurringFrom}"]`);
    const to = document.querySelector<HTMLElement>(`[data-ui="${UI.allocations.recurringTo}"]`);
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    expect(within(from!).queryAllByRole('group')).toHaveLength(0);
    expect(within(to!).queryAllByRole('group')).toHaveLength(0);
    expect(within(from!).getAllByRole('radio').length).toBeGreaterThan(0);
    // 行き先の説明（manualHint）は独立段落ではなく借方欄の hint として付く。
    expect(within(to!).getByText(t('recurring.manualHint'))).toBeInTheDocument();
  });

  it('初回の起票プレビューが基準日の位相・開始日・終了点へ追従する（編集・詳細を開いて操作）', async () => {
    await openEditSheet();
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringDetailsToggle}"]`)!,
    );
    setValue(UI.allocations.recurringEvery, '3');
    setValue(UI.allocations.recurringFirstPostingDate, '2026-01-10');
    setValue(UI.allocations.recurringStartDate, '2026-01-01');
    expect(previewText()).toContain('2026-01-10');

    // 基準日の年月を 1 ヶ月ずらすと位相ごとずれる（テンプレ文言では見えない差）。
    setValue(UI.allocations.recurringFirstPostingDate, '2026-02-10');
    expect(previewText()).toContain('2026-02-10');

    // 開始日を未来にすると、開始日以後の最初の位相月になる。
    setValue(UI.allocations.recurringFirstPostingDate, '2026-01-10');
    setValue(UI.allocations.recurringStartDate, '2026-06-01');
    expect(previewText()).toContain('2026-07-10');

    // 終了点が初回起票より前なら「起票されない」＝視覚行が消え、消えたことも通知される。
    setValue(UI.allocations.recurringEndDate, '2026-07-01');
    expect(previewText()).toBe('');
    expect(statusText()).toBe(t('recurring.firstPostingNone'));
  });

  it('新規: プレビューは初回の起票日そのものへ追従する（開始 = 初回の起票日で自動）', async () => {
    await openRuleSheet();
    setValue(UI.allocations.recurringEvery, '3');
    setValue(UI.allocations.recurringFirstPostingDate, '2026-01-10');
    expect(previewText()).toContain('2026-01-10');
    setValue(UI.allocations.recurringFirstPostingDate, '2026-02-10');
    expect(previewText()).toContain('2026-02-10');
  });

  it('終了日を「解除」ボタンで空へ戻せる（iOS の date input は空に戻せないため・編集の詳細内）', async () => {
    await openEditSheet();
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringDetailsToggle}"]`)!,
    );
    const q = (dataUi: string) => document.querySelector(`[data-ui="${dataUi}"]`);
    // 値が無い間は解除ボタン自体を出さない。
    expect(q(UI.allocations.recurringEndDateClear)).toBeNull();

    setValue(UI.allocations.recurringEndDate, '2027-01-31');
    const clear = q(UI.allocations.recurringEndDateClear);
    expect(clear).not.toBeNull();

    fireEvent.click(clear!);
    expect((q(UI.allocations.recurringEndDate) as HTMLInputElement).value).toBe('');
    expect(q(UI.allocations.recurringEndDateClear)).toBeNull();
  });

  it('周期が空の間は視覚行を出さず、status は「ありません」を通知する', async () => {
    await openRuleSheet();
    expect(previewText()).not.toBe('');
    setValue(UI.allocations.recurringEvery, '');
    expect(previewText()).toBe('');
    expect(statusText()).toBe(t('recurring.firstPostingNone'));
  });

  it('開いた直後の status も値を通知する（マウント後に effect が流し込む = 変化として読まれる）', async () => {
    await openRuleSheet();
    // 既定値（初回の起票日 = 今日・周期 1）では初回の起票が定まっている。
    const visual = previewText();
    expect(visual).not.toBe('');
    const date = visual.replace(t('recurring.firstPosting'), '').trim();
    expect(statusText()).toBe(t('recurring.firstPostingStatus', { date }));
  });
});
