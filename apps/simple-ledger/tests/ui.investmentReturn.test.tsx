/*
 * 投資科目の編集シート: 想定利回り（年率% ⇄ bp）+ 投影の計上先（§D）。
 *  - 投資（investment-asset）の編集にだけ 2 欄が出る。
 *  - % 入力は bp（整数）で保存され、再編集時に % へ復元される。
 *  - 「投資益」という名前の収入科目があれば計上先の先頭候補になる（自動確定はしない）。
 *  - 片方だけ・解釈できない % はエラーで保存されない（保存境界と同じ不変条件を入力時に知らせる）。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider } from '../src/state/store';
import { Accounts } from '../src/ui/screens/Accounts';
import { loadLedger, upsertAccount } from '../src/data/repository';
import { newId } from '../src/domain/ids';
import { nowIso } from '../src/util/time';
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

const returnInput = () =>
  document.querySelector<HTMLInputElement>(`[data-ui="${UI.accounts.annualReturn}"]`);
const projectionSelect = () =>
  document.querySelector<HTMLSelectElement>(`[data-ui="${UI.accounts.projectionAccount}"]`);

/** seed に「投資益」は無いので、サジェスト検証用に収入科目として追加する。 */
async function addGainAccount(): Promise<string> {
  const id = newId();
  const ts = nowIso();
  await upsertAccount({
    id,
    name: '投資益',
    type: 'revenue',
    role: 'income-category',
    archived: false,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

describe('投資科目の想定利回り編集', () => {
  it('% で入力すると bp で保存され、再編集で % へ復元される。「投資益」が先頭候補になる', async () => {
    const gainId = await addGainAccount();
    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    await openEdit('投資');

    const select = projectionSelect()!;
    // 候補 = 未設定 + 収入科目。「投資益」がサジェストとして先頭（未設定の直後）に出る。
    const labels = Array.from(select.options).map((o) => o.label);
    expect(labels[0]).toBe('未設定');
    expect(labels[1]).toBe('投資益');
    expect(select.value).toBe(''); // 自動確定しない

    fireEvent.change(returnInput()!, { target: { value: '3.25' } });
    fireEvent.change(select, { target: { value: gainId } });
    await saveSheet();

    const saved = (await loadLedger()).accounts.find((a) => a.name === '投資')!;
    expect(saved.annualReturnBp).toBe(325);
    expect(saved.projectionAccountId).toBe(gainId);

    await openEdit('投資');
    expect(returnInput()!.value).toBe('3.25');
    expect(projectionSelect()!.value).toBe(gainId);
  });

  it('両方空欄へ戻して保存するとフィールドごと消える', async () => {
    const gainId = await addGainAccount();
    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    await openEdit('投資');
    fireEvent.change(returnInput()!, { target: { value: '5' } });
    fireEvent.change(projectionSelect()!, { target: { value: gainId } });
    await saveSheet();

    await openEdit('投資');
    fireEvent.change(returnInput()!, { target: { value: '' } });
    fireEvent.change(projectionSelect()!, { target: { value: '' } });
    await saveSheet();

    const saved = (await loadLedger()).accounts.find((a) => a.name === '投資')!;
    expect(saved.annualReturnBp).toBeUndefined();
    expect(saved.projectionAccountId).toBeUndefined();
  });

  it('片方だけの設定はエラーで保存されない（セット検証）', async () => {
    await addGainAccount();
    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    await openEdit('投資');
    fireEvent.change(returnInput()!, { target: { value: '3' } });
    fireEvent.click(document.querySelector(`[data-ui="${UI.accounts.save}"]`)!);

    await screen.findByText('想定利回りと投影の計上先はセットで設定してください。');
    expect(document.querySelector(`[data-ui="${UI.accounts.save}"]`)).toBeInTheDocument();
    const saved = (await loadLedger()).accounts.find((a) => a.name === '投資')!;
    expect(saved.annualReturnBp).toBeUndefined();
  });

  it('解釈できない %（小数第 3 位・範囲外）はエラーで保存されない', async () => {
    const gainId = await addGainAccount();
    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    await openEdit('投資');
    fireEvent.change(returnInput()!, { target: { value: '3.256' } });
    fireEvent.change(projectionSelect()!, { target: { value: gainId } });
    fireEvent.click(document.querySelector(`[data-ui="${UI.accounts.save}"]`)!);

    await screen.findByText('想定利回りは -99.99〜1000%（小数第2位まで）で入力してください。');
    expect(document.querySelector(`[data-ui="${UI.accounts.save}"]`)).toBeInTheDocument();
    const saved = (await loadLedger()).accounts.find((a) => a.name === '投資')!;
    expect(saved.annualReturnBp).toBeUndefined();
  });

  it('計上先がアーカイブ済みなら「投影は生成されない」と名乗る（黙って消えない）', async () => {
    const gainId = await addGainAccount();
    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    await openEdit('投資');
    fireEvent.change(returnInput()!, { target: { value: '3' } });
    fireEvent.change(projectionSelect()!, { target: { value: gainId } });
    await saveSheet();

    // 計上先をアーカイブ（終了）する。投影エンジンは fail-closed で生成を止めるが、
    // 設定は残るため、編集シートで状態を名乗る（次点1・監査 2026-08-12）。
    const gain = (await loadLedger()).accounts.find((a) => a.id === gainId)!;
    await upsertAccount({
      ...gain,
      archived: true,
      endDate: '2026-01-31',
      updatedAt: nowIso(),
    });

    cleanup();
    _resetOverlaysForTests();
    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    await openEdit('投資');
    expect(projectionSelect()!.value).toBe(gainId);
    await screen.findByText(/計上先はアーカイブ済みのため、投影は生成されません/);
  });

  it('投資以外（現金）の編集には利回り欄が出ない', async () => {
    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    await openEdit('現金');
    expect(returnInput()).toBeNull();
    expect(projectionSelect()).toBeNull();
  });
});
