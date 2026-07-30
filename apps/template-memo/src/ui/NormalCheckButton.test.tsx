import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TemplateItem } from '../domain/template';
import { ItemRow } from './ProjectionFormCard';
import { NORMAL_HOLD_MS, NormalCheckButton } from './NormalCheckButton';

async function hold(element: HTMLElement, ms: number): Promise<void> {
  fireEvent.pointerDown(element);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  fireEvent.pointerUp(element);
}

const textItem: TemplateItem = {
  id: 'lung',
  kind: 'text',
  label: '肺音',
  normal: '明らかなラ音なし',
};

afterEach(cleanup);

function renderItem(rawValue: unknown, fresh = true) {
  const onWrite = vi.fn();
  render(
    <ItemRow
      item={textItem}
      rawValue={rawValue}
      hasLabelCol
      hasNormalCol
      freshTapRef={{ current: fresh }}
      onWrite={onWrite}
    />,
  );
  return {
    input: screen.getByRole('textbox', { name: '肺音' }),
    normal: screen.getByRole('button', { name: '正常' }),
    onWrite,
  };
}

describe('正常チェックの長押しガード', () => {
  it('単発 click と閾値未満の押下では発火しない', async () => {
    const onTrigger = vi.fn();
    render(
      <NormalCheckButton on={false} title="正常文を入力" ariaLabel="正常" onTrigger={onTrigger} />,
    );
    const button = screen.getByRole('button', { name: '正常' });

    fireEvent.click(button);
    expect(onTrigger).not.toHaveBeenCalled();

    await hold(button, Math.max(50, NORMAL_HOLD_MS - 250));
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('閾値を超える長押しで正常文を書き込み、キーボードは即時発火する', async () => {
    const { normal, onWrite } = renderItem(undefined);

    await hold(normal, NORMAL_HOLD_MS + 100);
    expect(onWrite).toHaveBeenCalledWith({
      value: textItem.normal,
      source: 'preset',
    });

    fireEvent.keyDown(normal, { key: 'Enter' });
    expect(onWrite).toHaveBeenCalledTimes(2);
  });

  it('preset は長押しで解除する', async () => {
    const preset = renderItem({ value: textItem.normal, source: 'preset' });
    await hold(preset.normal, NORMAL_HOLD_MS + 100);
    expect(preset.onWrite).toHaveBeenCalledWith('');
  });

  it('manual は長押ししても値を変えず入力欄へフォーカスする', async () => {
    const manual = renderItem({ value: '湿性ラ音あり', source: 'manual' });
    await hold(manual.normal, NORMAL_HOLD_MS + 100);
    expect(manual.onWrite).not.toHaveBeenCalled();
    expect(manual.input).toHaveFocus();
  });

  it('freshTapRef が閉じている間は長押しでも発火しない', async () => {
    const { normal, onWrite } = renderItem(undefined, false);
    await hold(normal, NORMAL_HOLD_MS + 100);
    expect(onWrite).not.toHaveBeenCalled();
  });
});
