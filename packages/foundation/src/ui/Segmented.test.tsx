/*
 * Segmented コントロールのテスト: 基本レンダリングと aria-selected。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Segmented } from './Segmented';

afterEach(() => {
  cleanup();
});

const items = [
  { key: 'a', label: '月次' },
  { key: 'b', label: '年次' },
  { key: 'c', label: '全期間' },
];

describe('Segmented', () => {
  it('全項目をレンダリングする', () => {
    render(<Segmented items={items} value="a" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '月次' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '年次' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '全期間' })).toBeInTheDocument();
  });

  it('value に対応するボタンが aria-selected=true', () => {
    render(<Segmented items={items} value="b" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '年次' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: '月次' })).toHaveAttribute('aria-selected', 'false');
  });

  it('ボタンをクリックすると onChange を正しいキーで呼ぶ', () => {
    const onChange = vi.fn();
    render(<Segmented items={items} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '全期間' }));
    expect(onChange).toHaveBeenCalledWith('c');
  });
});
