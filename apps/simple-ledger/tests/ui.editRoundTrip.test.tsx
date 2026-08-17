/*
 * **全編集シートの「開いて無変更で保存 → 保存値が 1 バイトも変わらない」回帰試験。**
 *
 * v11（金額の 1/100 単位化）で AdjustmentEditSheet が保存値（minor）を生でテキスト欄へ
 * 入れており、無変更保存だけで金額が 100 倍になる事故が起きた。原因は「保存値 → 表示テキスト」
 * の整形（formatMinorForInput）を 1 箇所だけ通していなかったこと。
 *
 * 個別の入力テストでは捕まらない（新規作成しか踏まないため）。**既存レコードを開いて
 * そのまま保存する**という経路を全シートで踏むのがこのファイルの役割で、
 * 同型の欠陥（保存 → 表示 → 保存の往復で値が変わる）を将来にわたって塞ぐ。
 *
 * 表示桁数（0 と 2）の両方で回すことも要点: 粗い表示は保存値を書き換えない。
 * 金額欄を実際に変更したときだけ、その入力値を保存する。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { AdjustmentEditSheet } from '../src/ui/AdjustmentSheet';
import { OpeningEditSheet } from '../src/ui/OpeningSheet';
import { EntrySheet } from '../src/ui/screens/EntrySheet';
import { AccountSheet } from '../src/ui/screens/AccountSheet';
import { Allocations } from '../src/ui/screens/Allocations';
import {
  createAdjustment,
  createContinuousCost,
  createOpening,
  createRecurringRule,
  loadLedger,
  updateSettings,
  upsertAccount,
  upsertEntry,
} from '../src/data/repository';
import { exportToJsonText } from '../src/data/exportImport';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import { accountBalance } from '../src/domain/accounting';
import type { Account, JournalEntry } from '../src/domain/types';
import type { SimpleEntryInput } from '../src/domain/entry';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <LedgerProvider>{children}</LedgerProvider>
    </ToastProvider>
  );
}

function Ready({ children }: { children: React.ReactNode }) {
  const { status } = useLedger();
  return status === 'ready' ? <>{children}</> : null;
}

async function setDigits(digits: 0 | 1 | 2) {
  const ledger = await loadLedger();
  await updateSettings({ ...ledger.settings, displayFractionDigits: digits });
}

const q = (name: string) => document.querySelector<HTMLElement>(`[data-ui="${name}"]`);

/** 端数を持つ金額（digits=0 では丸めて見えるが、保存値は保たれるべき）。 */
const AMOUNT = 123456; // 1,234.56

describe.each([0, 2] as const)('編集シートの open→save 往復（表示桁数 %i）', (digits) => {
  it('残高補正: 開いて無変更で保存しても actualBalance が変わらない（v11 の 100 倍バグの回帰）', async () => {
    await setDigits(digits);
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    await createAdjustment({ accountId: cash.id, date: '2026-03-01', actualBalance: AMOUNT });
    const before = (await loadLedger()).journalEntries.find((e) => e.metadata?.adjustment)!;
    expect(before.metadata!.adjustment!.actualBalance).toBe(AMOUNT);

    render(
      <Providers>
        <Ready>
          <AdjustmentEditSheet entry={before} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.adjustments.editDialog)).toBeInTheDocument());
    // 欄には「表示桁で整形した値」が入っている（生の minor ではない）。
    const input = q(UI.adjustments.editActual) as HTMLInputElement;
    expect(input.value).toBe(digits === 0 ? '1235' : '1234.56');

    fireEvent.click(q(UI.adjustments.editSave)!);
    await waitFor(async () => {
      const after = (await loadLedger()).journalEntries.find((e) => e.metadata?.adjustment)!;
      expect(after.metadata!.adjustment!.actualBalance).toBe(AMOUNT);
    });
  });

  it('初期残高: 開いて無変更で保存しても明細金額が変わらない', async () => {
    await setDigits(digits);
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    await createOpening({ accountId: cash.id, amount: AMOUNT, date: '2026-02-01' });
    const before = (await loadLedger()).journalEntries.find((e) => e.kind === 'opening')!;

    render(
      <Providers>
        <Ready>
          <OpeningEditSheet entry={before} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.adjustments.openingEditDialog)).toBeInTheDocument());
    const input = q(UI.adjustments.openingEditAmount) as HTMLInputElement;
    expect(input.value).toBe(digits === 0 ? '1235' : '1234.56');

    fireEvent.click(q(UI.adjustments.openingEditSave)!);
    await waitFor(async () => {
      const after = (await loadLedger()).journalEntries.find((e) => e.kind === 'opening')!;
      expect(after.lines[0]!.amount).toBe(AMOUNT);
    });
  });

  it('通常の仕訳: 開いて無変更で保存しても明細金額が変わらない', async () => {
    await setDigits(digits);
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const entry: JournalEntry = {
      id: 'round-trip-entry',
      date: todayLocal(),
      description: '往復確認',
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount: AMOUNT },
        { accountId: cash.id, side: 'credit', amount: AMOUNT },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    await upsertEntry(entry);

    render(
      <Providers>
        <Ready>
          <EntrySheet init={{ kind: 'edit', entry }} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.journal.entry.amount)).toBeInTheDocument());
    const input = q(UI.journal.entry.amount) as HTMLInputElement;
    expect(input.value).toBe(digits === 0 ? '1235' : '1234.56');

    fireEvent.click(q(UI.journal.entry.save)!);
    await waitFor(async () => {
      const after = (await loadLedger()).journalEntries.find((e) => e.id === entry.id)!;
      expect(after.lines[0]!.amount).toBe(AMOUNT);
    });
  });

  it('継続コスト資産: 開いて無変更で保存しても amount が変わらない', async () => {
    await setDigits(digits);
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const item = await createContinuousCost({
      name: '往復確認CC',
      amount: AMOUNT,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      expenseAccountId: expense.id,
    });

    render(
      <Providers>
        <Ready>
          <Allocations
            period={{ mode: 'all' }}
            onEditEntry={() => undefined}
            target={{ itemId: item.id }}
          />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.allocations.editDialog)).toBeInTheDocument());
    const input = q(UI.allocations.editAmount) as HTMLInputElement;
    expect(input.value).toBe(digits === 0 ? '1235' : '1234.56');

    fireEvent.click(q(UI.allocations.editSave)!);
    await waitFor(async () => {
      const after = (await loadLedger()).monthlyCostItems.find((m) => m.id === item.id)!;
      expect(after.amount).toBe(AMOUNT);
    });
  });

  it('くり返し記帳: 開いて無変更で保存しても amount が変わらない（金額変更の確認シートも出ない）', async () => {
    await setDigits(digits);
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const invest = ledger.accounts.find((a) => a.name === '投資')!;
    const today = todayLocal();
    const rule = await createRecurringRule({
      name: '往復確認ルール',
      amount: AMOUNT,
      dayOfMonth: 1,
      everyMonths: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: today.slice(0, 7),
      startDate: today,
    });

    render(
      <Providers>
        <Ready>
          <Allocations
            period={{ mode: 'all' }}
            onEditEntry={() => undefined}
            target={{ ruleId: rule.id }}
          />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.allocations.recurringSheet)).toBeInTheDocument());
    const input = q(UI.allocations.recurringAmount) as HTMLInputElement;
    expect(input.value).toBe(digits === 0 ? '1235' : '1234.56');

    fireEvent.click(q(UI.allocations.recurringSave)!);

    // 金額欄を触っていないため、どの表示桁でも確認シートなしで raw minor を保持する。
    await waitFor(async () => {
      const after = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;
      expect(after.amount).toBe(AMOUNT);
    });
    expect(q(UI.allocations.recurringAmountChangeDialog)).toBeNull();
  });
});

describe('保存値 → 表示 → 保存 が恒等になる金額（表示桁 2）', () => {
  it.each([1, 50, 99, 100, 101, 1234, 123456, 999999])('minor=%i は往復で不変', async (amount) => {
    await setDigits(2);
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const entry: JournalEntry = {
      id: `identity-${amount}`,
      date: todayLocal(),
      description: `恒等${amount}`,
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount },
        { accountId: cash.id, side: 'credit', amount },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    await upsertEntry(entry);

    render(
      <Providers>
        <Ready>
          <EntrySheet init={{ kind: 'edit', entry }} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.journal.entry.amount)).toBeInTheDocument());
    fireEvent.click(q(UI.journal.entry.save)!);
    await waitFor(async () => {
      const after = (await loadLedger()).journalEntries.find((e) => e.id === entry.id)!;
      expect(after.lines[0]!.amount).toBe(amount);
    });
    cleanup();
    _resetOverlaysForTests();
  });
});

/*
 * **「ぴったり相殺する額」は表示桁で丸めない**（編集の丸めとは別の族）。
 *
 * 逆仕訳・固定額の振替は、元の仕訳／残高を 1 minor まで打ち消すことが定義そのもの。
 * ここを編集フォームと同じ「表示桁で丸めてから保存」に乗せると、既定の表示桁 0 で
 * 100 の倍数でない金額（補正の delta・分割返済の端数・継続コストの月割り残）を扱うたびに
 * 端数が残り、科目の終了は error.account.archiveBalance で保存できなくなる。
 */
describe('打ち消しの額は表示桁 0 でも丸めない', () => {
  /** 100 の倍数でない minor（= 表示桁 0 では丸めて見える額）。 */
  const ODD = 12345; // 123.45

  it('逆仕訳: 表示桁 0 でも元と同額で、残高がちょうど元へ戻る', async () => {
    await setDigits(0);
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const source: JournalEntry = {
      id: 'reversal-source',
      date: todayLocal(),
      description: '端数のある支出',
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount: ODD },
        { accountId: cash.id, side: 'credit', amount: ODD },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    await upsertEntry(source);
    const before = accountBalance(cash.id, 'asset', (await loadLedger()).journalEntries);

    render(
      <Providers>
        <Ready>
          <EntrySheet init={{ kind: 'reversal', source }} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.journal.entry.amount)).toBeInTheDocument());
    // 欄には丸めた '123' ではなく、打ち消せる額そのものが出る。
    expect((q(UI.journal.entry.amount) as HTMLInputElement).value).toBe('123.45');

    fireEvent.click(q(UI.journal.entry.save)!);
    await waitFor(async () => {
      const after = (await loadLedger()).journalEntries.find(
        (e) => e.metadata?.reversalOfEntryId === source.id,
      );
      expect(after?.lines[0]?.amount).toBe(ODD);
    });
    const restored = accountBalance(cash.id, 'asset', (await loadLedger()).journalEntries);
    expect(restored).toBe(before + ODD); // 支出の取消なので現金が元に戻る
  });

  it('固定額の振替: 表示桁 0 でも残高ちょうどが入り、科目を終了できる', async () => {
    await setDigits(0);
    const ledger = await loadLedger();
    const from = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    await createOpening({ accountId: from.id, amount: ODD, date: '2026-01-01' });

    let saved: SimpleEntryInput | null = null;
    render(
      <Providers>
        <Ready>
          <EntrySheet
            init={{
              kind: 'transfer-fixed',
              fixed: {
                side: 'credit',
                accountId: from.id,
                amount: ODD,
                date: todayLocal(),
                onSave: async (input) => {
                  saved = input;
                },
              },
            }}
            onClose={() => undefined}
          />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.journal.entry.amount)).toBeInTheDocument());
    expect((q(UI.journal.entry.amount) as HTMLInputElement).value).toBe('123.45');

    // 相手側（振替先）を 1 つ選ぶ。
    const flowDest = document.querySelector(`[data-ui="${UI.journal.entry.flowDestination}"]`)!;
    fireEvent.click(flowDest.querySelector('label.chip input')!);
    fireEvent.click(q(UI.journal.entry.save)!);
    await waitFor(() => expect(saved).not.toBeNull());
    // 残高ちょうど。丸めると科目の終了が保存側（残高 0 の要求）で弾かれる。
    expect(saved!.amount).toBe(ODD);
  });

  // v13.4 ④: 返済シートは資金繰りではなく**月割り台帳の「支払用負債」**から開く。
  it('返済計画の「全額」既定: 表示桁 0 でも負債残高の端数を落とさない', async () => {
    await setDigits(0);
    const ledger = await loadLedger();
    const liability = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    await createOpening({ accountId: liability.id, amount: ODD, date: '2026-01-01' });

    render(
      <Providers>
        <Ready>
          <Allocations
            period={{ mode: 'date', date: todayLocal() }}
            onEditEntry={() => undefined}
          />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.allocations.repayAdd)).toBeInTheDocument());
    fireEvent.click(q(UI.allocations.repayAdd)!);
    await waitFor(() => expect(q(UI.allocations.repaySheet)).toBeInTheDocument());

    const amount = q(UI.allocations.repayAmount) as HTMLInputElement;
    expect(amount.value).toBe('123.45');
    expect(amount.inputMode).toBe('decimal');
  });
});

/*
 * **金額以外のフィールドも「開いて無変更で保存」で 1 バイトも変わらない。**
 *
 * 金額の往復だけを見ていると、state を持たない引き継ぎフィールド（note）や、
 * 開いた瞬間に既定値を作る欄（archived な科目の endDate）が、無変更保存で
 * 生えたり消えたりするのを取り逃がす。updatedAt / revision を除いた全体を比べる。
 */
describe('金額以外のフィールドの open→save 往復', () => {
  const ignoreVolatile = <T extends object>(o: T) =>
    JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'updatedAt')));

  it('勘定科目: 利回り・返済日・note・開始日を持つ科目が無変更保存で変わらない', async () => {
    const ledger = await loadLedger();
    const invest = ledger.accounts.find((a) => a.role === 'investment-asset')!;
    const income = ledger.accounts.find((a) => a.role === 'income-category')!;
    const seeded: Account = {
      ...invest,
      note: '引き継ぐだけのメモ',
      annualReturnBp: 350,
      projectionAccountId: income.id,
      startDate: '2026-01-01',
    };
    await upsertAccount(seeded);
    const before = (await loadLedger()).accounts.find((a) => a.id === invest.id)!;

    render(
      <Providers>
        <Ready>
          <AccountSheet existing={before} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.accounts.save)).toBeInTheDocument());
    fireEvent.click(q(UI.accounts.save)!);

    await waitFor(async () => {
      const after = (await loadLedger()).accounts.find((a) => a.id === invest.id)!;
      expect(ignoreVolatile(after)).toBe(ignoreVolatile(before));
    });
  });

  it('アーカイブ済みの科目: 無変更保存で終了日が今日へ寄らない', async () => {
    // archived ⇔ endDate は同じ状態を表す不変条件（repository の保存境界が守る）。
    // 編集シートは endDate 欄の既定値を updatedAt / today から作るため、
    // 「開いて保存し直しただけで終了日が今日へ動く」= 期間の判定が静かに変わる、が事故の形。
    const ledger = await loadLedger();
    const source = ledger.accounts.find((a) => a.role === 'expense-category')!;
    await upsertAccount({
      ...source,
      id: 'archived-with-end',
      name: '終了日つきのアーカイブ',
      archived: true,
      endDate: '2026-03-01',
    });
    const before = (await loadLedger()).accounts.find((a) => a.id === 'archived-with-end')!;
    expect(before.endDate).toBe('2026-03-01');

    render(
      <Providers>
        <Ready>
          <AccountSheet existing={before} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.accounts.save)).toBeInTheDocument());
    fireEvent.click(q(UI.accounts.save)!);

    await waitFor(async () => {
      const after = (await loadLedger()).accounts.find((a) => a.id === 'archived-with-end')!;
      expect(after.endDate).toBe('2026-03-01');
      expect(ignoreVolatile(after)).toBe(ignoreVolatile(before));
    });
  });

  it('台帳設定: 名前・単位・桁数を読み込んで保存し直しても export が通る', async () => {
    const before = (await loadLedger()).settings;
    await updateSettings({ ...before });
    const after = (await loadLedger()).settings;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    // 「保存はできるのに export だけ落ちる」を 1 行で拾う。
    expect(exportToJsonText(await loadLedger())).toContain('"schemaVersion": 13');
  });
});

/*
 * **変更判定は「onChange が発火したか」ではなく値で行う。**
 *
 * 「金額欄に触れない編集は保存済み minor を保持する」（Codex の仕様変更）の判定が
 * フラグ式だと、1 文字打って消した・除去される文字を打った、だけで「変更あり」になり、
 * 画面上は何も変わっていないのに隠れた端数が表示桁へ丸められて保存される。
 */
describe('金額欄を触っても値を戻せば無変更（表示桁 0）', () => {
  const AMT = 123456; // 表示桁 0 では '1235' と見える（保存値には端数がある）

  it('簿記編集: 1 文字打って消してから保存しても端数が保持される', async () => {
    await setDigits(0);
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const entry: JournalEntry = {
      id: 'touch-revert-entry',
      date: todayLocal(),
      description: '触って戻す',
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount: AMT },
        { accountId: cash.id, side: 'credit', amount: AMT },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    await upsertEntry(entry);

    render(
      <Providers>
        <Ready>
          <EntrySheet init={{ kind: 'edit', entry }} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.journal.entry.amount)).toBeInTheDocument());
    const input = q(UI.journal.entry.amount) as HTMLInputElement;
    expect(input.value).toBe('1235');
    // 触る → 戻す（欄の見た目は初期表示と同一に戻る）。
    fireEvent.change(input, { target: { value: '12355' } });
    fireEvent.change(input, { target: { value: '1235' } });
    fireEvent.click(q(UI.journal.entry.save)!);
    await waitFor(async () => {
      const after = (await loadLedger()).journalEntries.find((e) => e.id === entry.id)!;
      expect(after.lines[0]!.amount).toBe(AMT); // 123500 に丸められない
    });
  });

  it('残高補正の編集: 同様に端数が保持される', async () => {
    await setDigits(0);
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    await createAdjustment({ accountId: cash.id, date: '2026-03-01', actualBalance: AMT });
    const before = (await loadLedger()).journalEntries.find((e) => e.metadata?.adjustment)!;

    render(
      <Providers>
        <Ready>
          <AdjustmentEditSheet entry={before} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.adjustments.editDialog)).toBeInTheDocument());
    const input = q(UI.adjustments.editActual) as HTMLInputElement;
    expect(input.value).toBe('1235');
    fireEvent.change(input, { target: { value: '1235a' } }); // 除去される文字だけ
    fireEvent.change(input, { target: { value: '12351' } });
    fireEvent.change(input, { target: { value: '1235' } });
    fireEvent.click(q(UI.adjustments.editSave)!);
    await waitFor(async () => {
      const after = (await loadLedger()).journalEntries.find((e) => e.metadata?.adjustment)!;
      expect(after.metadata!.adjustment!.actualBalance).toBe(AMT);
    });
  });

  it('実際に変更したときは入力値が保存される（保持が過剰に効かない）', async () => {
    await setDigits(0);
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const entry: JournalEntry = {
      id: 'touch-change-entry',
      date: todayLocal(),
      description: '本当に変える',
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount: AMT },
        { accountId: cash.id, side: 'credit', amount: AMT },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    await upsertEntry(entry);

    render(
      <Providers>
        <Ready>
          <EntrySheet init={{ kind: 'edit', entry }} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.journal.entry.amount)).toBeInTheDocument());
    fireEvent.change(q(UI.journal.entry.amount)!, { target: { value: '2000' } });
    fireEvent.click(q(UI.journal.entry.save)!);
    await waitFor(async () => {
      const after = (await loadLedger()).journalEntries.find((e) => e.id === entry.id)!;
      expect(after.lines[0]!.amount).toBe(200000);
    });
  });
});
