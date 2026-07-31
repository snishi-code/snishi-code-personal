/*
 * 「自由に動かせる」チェック（現預金の内訳のみ・既定 ON）:
 *  - OFF で保存すると movable=false が付く。ON に戻すと保存境界の正規化でフィールドごと消える。
 *  - 負債の編集シートには出さない。
 *  - 新規作成（初期残高つき = createOpening 経路）でも OFF を引き継ぐ。
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

describe('「自由に動かせる」チェック', () => {
  it('現預金の編集で既定 ON。OFF 保存 → movable=false・ON へ戻すとフィールドが消える', async () => {
    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    await openEdit('現金');

    const checkbox = screen.getByRole('checkbox', { name: '自由に動かせる' });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    await saveSheet();

    await waitFor(
      async () => {
        const cash = (await loadLedger()).accounts.find((a) => a.name === '現金');
        expect(cash?.movable).toBe(false);
      },
      { timeout: 3000 },
    );

    // ON に戻して保存 → 既定 ON なのでフィールドごと消える（保存境界の正規化）。
    await openEdit('現金');
    const again = screen.getByRole('checkbox', { name: '自由に動かせる' });
    expect(again).not.toBeChecked();
    fireEvent.click(again);
    await saveSheet();
    await waitFor(
      async () => {
        const cash = (await loadLedger()).accounts.find((a) => a.name === '現金');
        expect(cash?.movable).toBeUndefined();
      },
      { timeout: 3000 },
    );
  });

  it('負債の編集シートには出さない', async () => {
    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    await openEdit('クレジットカード');
    expect(screen.queryByRole('checkbox', { name: '自由に動かせる' })).not.toBeInTheDocument();
  });

  it('新規作成（初期残高つき）でも movable=false を引き継ぐ', async () => {
    await loadLedger();
    await createOpening({
      newAccount: { name: 'Suica', type: 'asset', role: 'daily-asset', movable: false },
      amount: 3000,
      date: '2026-01-01',
    });
    const suica = (await loadLedger()).accounts.find((a) => a.name === 'Suica');
    expect(suica?.movable).toBe(false);
  });
});
