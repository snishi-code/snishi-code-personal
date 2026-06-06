/*
 * UI 統合テスト: アプリを描画し、仕訳を 1 件追加すると一覧と集計に反映されることを確認。
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

describe('App 仕訳追加フロー', () => {
  it('仕訳を追加するとホームの一覧と費用集計に反映される', async () => {
    const user = userEvent.setup();
    renderApp();

    // 初期化完了（ホーム見出し）を待つ
    expect(await screen.findByRole('heading', { name: 'ホーム' })).toBeInTheDocument();

    // ヘッダーの「+ 仕訳を追加」を開く
    await user.click(screen.getByRole('button', { name: '仕訳を追加' }));

    // フォーム入力
    await user.clear(screen.getByLabelText(/摘要/));
    await user.type(screen.getByLabelText(/摘要/), 'ランチ');
    await user.selectOptions(screen.getByLabelText(/借方/), '食費');
    await user.selectOptions(screen.getByLabelText(/貸方/), '現金');
    await user.type(screen.getByLabelText(/金額/), '1000');

    // 保存
    await user.click(screen.getByRole('button', { name: '保存' }));

    // ホームの最近の仕訳に表示される
    expect(await screen.findByText('ランチ')).toBeInTheDocument();

    // 金額 ¥1,000 が（最近の仕訳・費用集計に）反映される
    const amounts = await screen.findAllByText((text) => text.includes('1,000'));
    expect(amounts.length).toBeGreaterThan(0);
  });

  it('必須未入力だと検証エラーを表示し、保存しない', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'ホーム' });

    await user.click(screen.getByRole('button', { name: '仕訳を追加' }));
    // 摘要を空にして保存
    await user.clear(screen.getByLabelText(/摘要/));
    await user.click(screen.getByRole('button', { name: '保存' }));

    // ダイアログは開いたまま、エラーメッセージが出る
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('摘要を入力してください。')).toBeInTheDocument();
  });
});
