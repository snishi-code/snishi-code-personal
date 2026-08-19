/*
 * 入力カードの行 (ItemRow) と配置 (PlacementRows) の DOM テスト。
 *
 * 固定したいこと:
 *   - text の入力欄に文字種の制約 (inputMode / pattern) を付けない。
 *     iOS の numeric パッドには "." も "/" も無く、36.5 も 120/80 も入力不能になるため。
 *   - decimal の入力欄は inputMode だけ decimal にし、type / pattern では狭めない
 *     (出るキーボードを寄せるだけで、打てる文字も貼り付けも制限しない)。
 *   - 旧 number / fraction の保存形 { value, note? } を値として読み、編集しても note を捨てない。
 *   - フォーマット名の見出しを出す条件 (showName / シート内 / ラベル列なし配置)。
 */

import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItemRow, PlacementRows } from './ProjectionFormCard';
import type { PlacedFormat, TemplateItem } from '../domain/template';

afterEach(cleanup);

const freshTapRef = createRef<boolean>() as { current: boolean };
freshTapRef.current = true;

function renderItem(item: TemplateItem, rawValue: unknown, onWrite = vi.fn()) {
  render(
    <ItemRow
      item={item}
      rawValue={rawValue}
      hasLabelCol
      hasNormalCol={false}
      freshTapRef={freshTapRef}
      onWrite={onWrite}
    />,
  );
  return onWrite;
}

function placed(over: Partial<PlacedFormat>): PlacedFormat {
  return {
    id: 'plm',
    name: 'バイタル',
    display: 'always',
    joiner: ', ',
    labelSep: ' ',
    titleWrap: '',
    items: [{ id: 'a', label: 'BP', kind: 'text', unit: 'mmHg' }],
    ...over,
  };
}

describe('ItemRow の入力欄', () => {
  it('数字項目は inputMode だけ decimal にし、type / pattern では狭めない', () => {
    renderItem({ id: 'a', label: 'BT', kind: 'decimal', unit: '℃' }, '');
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('inputmode', 'decimal');
    expect(input).not.toHaveAttribute('pattern');
    expect(input).toHaveAttribute('type', 'text');
  });

  it('数字項目でも打った文字はそのまま保存する', () => {
    const onWrite = renderItem({ id: 'a', label: 'BT', kind: 'decimal', unit: '℃' }, '');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '36.5' } });
    expect(onWrite).toHaveBeenLastCalledWith({ value: '36.5', source: 'manual' });
  });

  it('文字種を狭めない（inputMode / pattern を持たない）', () => {
    renderItem({ id: 'a', label: 'BT', kind: 'text', unit: '℃' }, '');
    const input = screen.getByRole('textbox');
    expect(input).not.toHaveAttribute('inputmode');
    expect(input).not.toHaveAttribute('pattern');
    expect(input).toHaveAttribute('type', 'text');
  });

  it('小数点もスラッシュもそのまま保存する', () => {
    const onWrite = renderItem({ id: 'a', label: 'BT', kind: 'text', unit: '℃' }, '');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '36.5' } });
    expect(onWrite).toHaveBeenLastCalledWith({ value: '36.5', source: 'manual' });

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '120/80' } });
    expect(onWrite).toHaveBeenLastCalledWith({ value: '120/80', source: 'manual' });
  });

  it('ラベルには単位を併記する（aria 上も「BP（mmHg）」で一意になる）', () => {
    renderItem({ id: 'a', label: 'BP', kind: 'text', unit: 'mmHg' }, '');
    expect(screen.getByRole('textbox', { name: 'BP（mmHg）' })).toBeInTheDocument();
  });

  it('旧 number/fraction の保存形をそのまま表示する', () => {
    renderItem({ id: 'a', label: 'BP', kind: 'text', unit: 'mmHg' }, { value: '120/80' });
    expect(screen.getByRole('textbox')).toHaveValue('120/80');
  });

  it('旧 note は編集しても捨てない（入力 UI が無いので消えたら復元できない）', () => {
    const onWrite = renderItem(
      { id: 'a', label: 'SpO2', kind: 'text', unit: '%' },
      { value: '96', note: 'O2 2L' },
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '98' } });
    expect(onWrite).toHaveBeenLastCalledWith({ value: '98', source: 'manual', note: 'O2 2L' });
  });
});

describe('PlacementRows のフォーマット名見出し', () => {
  const rows = (p: PlacedFormat, showHead?: boolean) =>
    render(
      <PlacementRows
        placement={p}
        values={{}}
        freshTapRef={freshTapRef}
        showHead={showHead}
        onWrite={vi.fn()}
      />,
    );

  it('既定では見出しを出す', () => {
    const { container } = rows(placed({}));
    expect(screen.getByText('バイタル')).toBeInTheDocument();
    expect(container.querySelector('.projectionRows.noHead')).toBeNull();
  });

  it('showName:false は見出しを消し、境界を戻すため noHead を付ける', () => {
    const { container } = rows(placed({ showName: false }));
    expect(screen.queryByText('バイタル')).toBeNull();
    expect(container.querySelector('.projectionRows.noHead')).not.toBeNull();
  });

  it('名前が空なら showName に関わらず見出しは出ない', () => {
    rows(placed({ name: '' }));
    expect(document.querySelector('.projectionPlacementHead')).toBeNull();
  });

  it('ラベル列を持たない配置では showName:false でも見出しを残す', () => {
    // 項目ラベルもフォーマット名も無いと、匿名の入力枠が並ぶだけで特定できなくなる。
    rows(
      placed({
        showName: false,
        name: '血糖',
        items: [
          { id: 'a', label: '', kind: 'text' },
          { id: 'b', label: '', kind: 'text' },
        ],
      }),
    );
    expect(screen.getByText('血糖')).toBeInTheDocument();
  });

  it('シートの中 (showHead=false) では見出しを出さない（Modal title と二重になるため）', () => {
    rows(placed({}), false);
    expect(screen.queryByText('バイタル')).toBeNull();
  });
});
