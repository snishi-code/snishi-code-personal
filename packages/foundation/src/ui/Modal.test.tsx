/*
 * Modal のテスト: dismissMode × backdrop/Escape 制御、フォーカス restore、
 * footer/title 表示。native <dialog> ベース（jsdom 29 実装済み）。
 * jsdom が showModal を未実装の場合は test-utils の shim を適用する。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Modal } from './Modal';
import { patchDialogIfNeeded } from './test-utils';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
});

// jsdom の <dialog> は showModal が呼ばれると open 属性が付き、
// cancel イベントが発火する（Escape キー相当）。
// backdrop クリックは dialog 自身の click として届く。

function renderModal(onClose: () => void, dismissMode: 'always' | 'if-clean' | 'never' = 'always') {
  return render(
    <Modal title="テストモーダル" onClose={onClose} dismissMode={dismissMode}>
      <p>内容</p>
    </Modal>,
  );
}

describe('Modal — title/footer', () => {
  it('title を表示する', () => {
    const onClose = vi.fn();
    renderModal(onClose);
    expect(screen.getByText('テストモーダル')).toBeInTheDocument();
  });

  it('footer を渡すと表示する', () => {
    const onClose = vi.fn();
    render(
      <Modal title="確認" onClose={onClose} footer={<button>保存</button>}>
        <p>内容</p>
      </Modal>,
    );
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
  });

  it('titleVariant=sr-only でも aria-labelledby は維持する', () => {
    const onClose = vi.fn();
    render(
      <Modal title="非表示タイトル" onClose={onClose} titleVariant="sr-only">
        <p>内容</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
  });
});

describe('Modal — dismissMode=always', () => {
  it('cancel イベント（Escape 相当）で onClose を呼ぶ', () => {
    const onClose = vi.fn();
    renderModal(onClose, 'always');
    const dialog = screen.getByRole('dialog');
    // dialog の cancel イベントを発火（Escape キー相当）
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('backdrop クリック（dialog 自身への click かつ境界外）で onClose を呼ぶ', () => {
    const onClose = vi.fn();
    renderModal(onClose, 'always');
    const dialog = screen.getByRole('dialog');
    // getBoundingClientRect が (0,0,0,0) を返す jsdom では
    // clientX/Y が全て 0 のとき「境界外」として扱われる
    fireEvent.click(dialog, { target: dialog, clientX: -1, clientY: -1 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Modal — dismissMode=if-clean', () => {
  it('cancel イベントで onClose を呼ぶ（always と同じ挙動）', () => {
    const onClose = vi.fn();
    renderModal(onClose, 'if-clean');
    const dialog = screen.getByRole('dialog');
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Modal — dismissMode=never', () => {
  it('cancel イベントで onClose を呼ばない', () => {
    const onClose = vi.fn();
    renderModal(onClose, 'never');
    const dialog = screen.getByRole('dialog');
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('backdrop クリックで onClose を呼ばない', () => {
    const onClose = vi.fn();
    renderModal(onClose, 'never');
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog, { target: dialog, clientX: -1, clientY: -1 });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Modal — フォーカス restore', () => {
  it('閉じたとき呼び出し元へフォーカスを戻す', () => {
    // 呼び出し元ボタン
    const trigger = document.createElement('button');
    trigger.textContent = '開く';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = renderModal(vi.fn());
    unmount(); // dialog が閉じられる
    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });
});
