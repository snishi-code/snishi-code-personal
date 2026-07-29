import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { MonthField } from '../src/ui/MonthField';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function Harness({ optional = false }: { optional?: boolean }) {
  const [value, setValue] = useState(optional ? '2026-07' : '2026-01');
  return (
    <MonthField
      label={optional ? '終了月' : '開始月'}
      value={value}
      onChange={setValue}
      required={!optional}
      {...(optional ? { clearLabel: '未設定に戻す' } : {})}
    />
  );
}

describe('MonthField', () => {
  it('年送りと12か月グリッドで YYYY-MM を選ぶ', () => {
    render(<Harness />);

    fireEvent.click(screen.getByLabelText('開始月'));
    expect(document.querySelector('input[type="month"]')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(15);

    fireEvent.click(screen.getByRole('button', { name: '2027' }));
    fireEvent.click(screen.getByRole('button', { name: '2' }));

    expect(screen.getByLabelText('開始月')).toHaveTextContent('2027-02');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('任意欄は未設定へ戻せる（未設定は placeholder を出す）', () => {
    render(<Harness optional />);

    fireEvent.click(screen.getByLabelText('終了月'));
    fireEvent.click(screen.getByRole('button', { name: '未設定に戻す' }));

    // 空表示にするとアイコンだけのボタンになるため placeholder を出す。
    expect(screen.getByLabelText('終了月')).toHaveTextContent('YYYY-MM');
  });
});
