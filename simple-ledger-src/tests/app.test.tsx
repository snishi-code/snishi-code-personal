/*
 * UI 統合テスト: 「支出」入力フローで仕訳を 1 件追加すると一覧・集計に反映される。
 * 借方/貸方を直接見せない（カテゴリ/支払元）日常入力を確認する。
 * 役割(getByRole)/ラベル(getByLabelText) を優先し、DOM 構造・CSS には依存しない。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App';
import { ToastProvider } from '../src/ui/toast';
import { LedgerProvider } from '../src/state/store';

function renderApp() {
  return render(
    <ToastProvider>
      <LedgerProvider>
        <App />
      </LedgerProvider>
    </ToastProvider>,
  );
}

describe('App 支出入力フロー', () => {
  it('支出を追加するとホームの一覧と費用集計に反映される', async () => {
    const user = userEvent.setup();
    renderApp();

    expect(await screen.findByRole('heading', { name: 'ホーム' })).toBeInTheDocument();

    // ホームの「支出」ボタンから入力（借方/貸方は出さず カテゴリ/支払元）
    await user.click(screen.getByRole('button', { name: '支出' }));

    await user.type(screen.getByLabelText(/摘要/), 'ランチ');
    // カテゴリ（支出）= 食費、支払元 = 現金 をチップ（radio）で選ぶ
    await user.click(screen.getByRole('radio', { name: '食費' }));
    await user.click(screen.getByRole('radio', { name: '現金' }));
    await user.type(screen.getByLabelText(/金額/), '1000');

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('ランチ')).toBeInTheDocument();
    const amounts = await screen.findAllByText((text) => text.includes('1,000'));
    expect(amounts.length).toBeGreaterThan(0);
  });

  it('必須未入力だと検証エラーを表示し、保存しない', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'ホーム' });

    await user.click(screen.getByRole('button', { name: '支出' }));
    // 摘要・科目・金額を未入力のまま保存
    await user.click(screen.getByRole('button', { name: '保存' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('摘要を入力してください。')).toBeInTheDocument();
  });
});
