// OncallSheet の操作テスト: 「入力 → 本文へ挿入」で合成文が onInsert に渡ること。
// 挿入ボタンのタップは「フォーカス中 input の blur → 同期 commit → click」の順で
// 動く設計（valuesRef が正本）のため、実イベント列で回帰を固定する。
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import type { TemplateGroup } from '../domain/template';
import { OncallSheet } from './OncallSheet';

patchDialogIfNeeded();
afterEach(cleanup);

const GLU_GROUP: TemplateGroup = {
  id: 'grp_glu',
  name: '血糖',
  display: 'oncall',
  joiner: '-',
  labelSep: ' ',
  titleWrap: '',
  items: [
    { id: 'itm_1', label: 'Glu', kind: 'number' },
    { id: 'itm_2', label: '', kind: 'number' },
    { id: 'itm_3', label: '', kind: 'number' },
  ],
};

describe('OncallSheet', () => {
  it('値を入れて挿入すると合成文が渡り、シートが閉じる', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(<OncallSheet group={GLU_GROUP} onInsert={onInsert} onClose={onClose} />);

    await user.type(screen.getByLabelText('Glu'), '108');
    const noLabel = screen.getAllByLabelText('入力');
    await user.type(noLabel[0]!, '222');
    await user.type(noLabel[1]!, '100');
    // blur を経ずに直接ボタンを押す（実機のタップと同じ: mousedown で blur → commit → click）
    await user.click(screen.getByRole('button', { name: '本文へ挿入' }));

    expect(onInsert).toHaveBeenCalledWith('Glu 108-222-100');
    expect(onClose).toHaveBeenCalled();
  });

  it('全項目が空のまま挿入すると、何も挿入せず閉じるだけ', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(<OncallSheet group={GLU_GROUP} onInsert={onInsert} onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: '本文へ挿入' }));

    expect(onInsert).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
