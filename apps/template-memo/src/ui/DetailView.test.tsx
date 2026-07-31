import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFreshTapGuard } from './DetailView';

function GuardProbe({ pid, onRead }: { pid: string | null; onRead: (fresh: boolean) => void }) {
  const freshTapRef = useFreshTapGuard(pid);
  return <button onClick={() => onRead(freshTapRef.current)}>確認</button>;
}

afterEach(cleanup);

describe('詳細画面のゴーストタップガード', () => {
  it('入場直後と pid 切替直後は閉じ、新しい pointerdown の後だけ開く', () => {
    const onRead = vi.fn();
    const { rerender } = render(<GuardProbe pid="patient-a" onRead={onRead} />);
    const button = screen.getByRole('button', { name: '確認' });

    fireEvent.click(button);
    expect(onRead).toHaveBeenLastCalledWith(false);

    fireEvent.pointerDown(window);
    fireEvent.click(button);
    expect(onRead).toHaveBeenLastCalledWith(true);

    rerender(<GuardProbe pid="patient-b" onRead={onRead} />);
    fireEvent.click(button);
    expect(onRead).toHaveBeenLastCalledWith(false);
  });

  it('キーボード操作 (keydown) でも開く (ポインタ無しの a11y 経路を殺さない)', () => {
    const onRead = vi.fn();
    render(<GuardProbe pid="patient-a" onRead={onRead} />);
    const button = screen.getByRole('button', { name: '確認' });

    fireEvent.click(button);
    expect(onRead).toHaveBeenLastCalledWith(false);

    fireEvent.keyDown(window, { key: 'Tab' });
    fireEvent.click(button);
    expect(onRead).toHaveBeenLastCalledWith(true);
  });
});
