/*
 * Button コンポーネントのテスト: 基本レンダリングと aria。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Button } from './Button';

afterEach(() => {
  cleanup();
});

describe('Button', () => {
  it('テキストを表示する', () => {
    render(<Button>保存</Button>);
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
  });

  it('type 既定は button（フォーム submit を防ぐ）', () => {
    render(<Button>送信</Button>);
    expect(screen.getByRole('button', { name: '送信' })).toHaveAttribute('type', 'button');
  });

  it('disabled で操作不可になる', () => {
    render(<Button disabled>送信</Button>);
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
  });

  it('onClick を呼ぶ', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>クリック</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'クリック' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('variant=primary で btn--primary クラスが付く', () => {
    render(<Button variant="primary">実行</Button>);
    expect(screen.getByRole('button', { name: '実行' })).toHaveClass('btn--primary');
  });

  it('variant=danger で btn--danger クラスが付く', () => {
    render(<Button variant="danger">削除</Button>);
    expect(screen.getByRole('button', { name: '削除' })).toHaveClass('btn--danger');
  });

  it('variant=ghost で btn--ghost クラスが付く', () => {
    render(<Button variant="ghost">キャンセル</Button>);
    expect(screen.getByRole('button', { name: 'キャンセル' })).toHaveClass('btn--ghost');
  });

  it('block=true で btn--block クラスが付く', () => {
    render(<Button block>保存</Button>);
    expect(screen.getByRole('button', { name: '保存' })).toHaveClass('btn--block');
  });
});
