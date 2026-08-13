import { describe, expect, it } from 'vitest';
import type { TemplateItem } from '../domain/template';
import { morphItemKind } from './FormatEditView';

describe('morphItemKind', () => {
  it('kind ごとの専用フィールドを排他的に初期化する', () => {
    const item: TemplateItem = {
      id: 'item',
      label: '項目',
      kind: 'text',
      unit: 'mmHg',
      normal: '正常',
    };

    // text → select: 単位も正常文も select では意味を持たないので捨てる。
    morphItemKind(item, 'select');
    expect(item).toEqual({
      id: 'item',
      label: '項目',
      kind: 'select',
      options: ['選択肢'],
    });

    // select → text: 選択肢を捨てる。
    morphItemKind(item, 'text');
    expect(item).toEqual({ id: 'item', label: '項目', kind: 'text' });
  });

  it('廃止した kind（number/fraction）は受け付けない（fail-closed）', () => {
    const item: TemplateItem = { id: 'item', label: 'BP', kind: 'text', unit: 'mmHg' };

    morphItemKind(item, 'number' as never);
    expect(item).toEqual({ id: 'item', label: 'BP', kind: 'text', unit: 'mmHg' });

    morphItemKind(item, 'fraction' as never);
    expect(item).toEqual({ id: 'item', label: 'BP', kind: 'text', unit: 'mmHg' });
  });

  it('未知の kind は無変更 (DOM 由来値の fail-closed)', () => {
    const item: TemplateItem = { id: 'item', label: '項目', kind: 'text', normal: '正常' };

    morphItemKind(item, 'bogus' as never);
    expect(item).toEqual({ id: 'item', label: '項目', kind: 'text', normal: '正常' });
  });
});
