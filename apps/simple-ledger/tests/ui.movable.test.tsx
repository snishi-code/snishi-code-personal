/*
 * 「自由に動かせるか」は箱そのものが表す（2 箱化・チェックボックスとチップは撤去済み）:
 *  - 「動かせない」箱で新規作成 → movable=false で保存（箱 = 作成時に確定）。
 *  - 編集シートにチェックは無く、無変更保存で既存の movable=false を落とさない。
 *  - 一覧にチップは無い（所属箱の位置がその情報を表す）。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider } from '../src/state/store';
import { Accounts } from '../src/ui/screens/Accounts';
import { createOpening, loadLedger } from '../src/data/repository';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
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

async function openEdit(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `編集: ${name}` }));
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.accounts.save}"]`)).toBeInTheDocument();
  });
}

/** 保存 → シートが閉じるまで待つ（閉じた時点で store の refresh も済んでいる）。 */
async function saveSheet() {
  fireEvent.click(document.querySelector(`[data-ui="${UI.accounts.save}"]`)!);
  await waitFor(
    () => {
      expect(document.querySelector(`[data-ui="${UI.accounts.save}"]`)).not.toBeInTheDocument();
    },
    { timeout: 3000 },
  );
}

describe('自由に動かせない箱（movable の UI 撤去後）', () => {
  it('編集シートにチェックボックスが無く、無変更保存でも movable=false を落とさない', async () => {
    // 既存の movable=false 科目（seed のチャージ残高を OFF 化）を用意。
    const ledger = await loadLedger();
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    const { upsertAccount } = await import('../src/data/repository');
    await upsertAccount({ ...charge, movable: false });

    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    await openEdit('チャージ残高');
    // チェックボックスは存在しない（箱がその情報を表す）。
    expect(document.querySelector('[data-ui="accounts.movable"]')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '自由に動かせる' })).toBeNull();

    await saveSheet();
    await waitFor(async () => {
      const after = (await loadLedger()).accounts.find((a) => a.name === 'チャージ残高');
      // 無変更保存でフラグが落ちない = 箱の所属が変わらない。
      expect(after?.movable).toBe(false);
    });
  });

  it('一覧に「自由に動かせない」チップは出ない（箱の位置が表す）', async () => {
    const ledger = await loadLedger();
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    const { upsertAccount } = await import('../src/data/repository');
    await upsertAccount({ ...charge, movable: false });

    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    const fixedHead = await waitFor(() => {
      const el = document.querySelector(`[data-ui="${UI.accounts.box}.cashFixed"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(fixedHead.parentElement).toHaveTextContent('チャージ残高');
    expect(document.querySelector('[data-ui="accounts.notMovableBadge"]')).toBeNull();
    expect(document.body.textContent).not.toContain('自由に動かせないお金の内訳: 自由に動かせない');
  });

  it('「動かせない」箱で新規作成すると movable=false で保存される（箱 = 作成時に確定）', async () => {
    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    const fixedHead = await waitFor(() => {
      const el = document.querySelector(`[data-ui="${UI.accounts.box}.cashFixed"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(fixedHead.querySelector(`[data-ui="${UI.accounts.create}"]`)!);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.accounts.save}"]`)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/科目名/), { target: { value: 'チャージ残高2' } });
    await saveSheet();
    await waitFor(async () => {
      const created = (await loadLedger()).accounts.find((a) => a.name === 'チャージ残高2');
      expect(created?.role).toBe('daily-asset');
      expect(created?.movable).toBe(false);
    });
  });

  it('「動かせる」箱で新規作成すると movable フィールド自体を持たない（既定 = 自由）', async () => {
    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    const freeHead = await waitFor(() => {
      const el = document.querySelector(`[data-ui="${UI.accounts.box}.cash"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(freeHead.querySelector(`[data-ui="${UI.accounts.create}"]`)!);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.accounts.save}"]`)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/科目名/), { target: { value: '第二現金' } });
    await saveSheet();
    await waitFor(async () => {
      const created = (await loadLedger()).accounts.find((a) => a.name === '第二現金');
      expect(created?.role).toBe('daily-asset');
      expect(created?.movable).toBeUndefined();
    });
  });
});
