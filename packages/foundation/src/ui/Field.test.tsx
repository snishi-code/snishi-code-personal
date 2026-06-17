/*
 * Field コンポーネント群のテスト: 基本レンダリングと aria。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TextInput, SelectInput, TextArea } from './Field';

afterEach(() => {
  cleanup();
});

describe('TextInput', () => {
  it('ラベルと入力欄が結びつく（getByLabelText で取得できる）', () => {
    render(<TextInput label="メモ" value="" onChange={vi.fn()} />);
    expect(screen.getByLabelText('メモ')).toBeInTheDocument();
  });

  it('エラーが role=alert で表示される', () => {
    render(<TextInput label="金額" value="" onChange={vi.fn()} error="必須項目です" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('必須項目です');
  });

  it('エラーがあると input に aria-invalid=true が付く', () => {
    render(<TextInput label="金額" value="" onChange={vi.fn()} error="エラー" />);
    const input = screen.getByLabelText('金額');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('hint が表示される', () => {
    render(<TextInput label="名前" value="" onChange={vi.fn()} hint="フルネームで入力" />);
    expect(screen.getByText('フルネームで入力')).toBeInTheDocument();
  });

  it('値の変化で onChange を呼ぶ', () => {
    const onChange = vi.fn();
    render(<TextInput label="名前" value="山田" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: '鈴木' } });
    expect(onChange).toHaveBeenCalledWith('鈴木');
  });

  it('required で「（必須）」ラベルを表示する', () => {
    render(<TextInput label="名前" value="" onChange={vi.fn()} required />);
    expect(screen.getByText('（必須）')).toBeInTheDocument();
  });
});

describe('SelectInput', () => {
  const options = [
    { value: 'a', label: 'オプション A' },
    { value: 'b', label: 'オプション B' },
  ];

  it('ラベルと select が結びつく', () => {
    render(<SelectInput label="種別" value="a" onChange={vi.fn()} options={options} />);
    expect(screen.getByLabelText('種別')).toBeInTheDocument();
  });

  it('選択の変化で onChange を呼ぶ', () => {
    const onChange = vi.fn();
    render(<SelectInput label="種別" value="a" onChange={onChange} options={options} />);
    fireEvent.change(screen.getByLabelText('種別'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('TextArea', () => {
  it('ラベルと textarea が結びつく', () => {
    render(<TextArea label="メモ" value="" onChange={vi.fn()} />);
    expect(screen.getByLabelText('メモ')).toBeInTheDocument();
  });

  it('エラーで aria-invalid が付く', () => {
    render(<TextArea label="メモ" value="" onChange={vi.fn()} error="入力してください" />);
    const area = screen.getByLabelText('メモ');
    expect(area).toHaveAttribute('aria-invalid', 'true');
  });
});
