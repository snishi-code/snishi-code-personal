import { describe, expect, it } from 'vitest';
import type { TemplateItem } from '../domain/template';
import { morphItemKind } from './TemplateEditView';

describe('morphItemKind', () => {
  it('kind ごとの専用フィールドを排他的に初期化する', () => {
    const item: TemplateItem = {
      id: 'item',
      label: '項目',
      kind: 'text',
      normal: '正常',
    };

    morphItemKind(item, 'number');
    expect(item).toEqual({ id: 'item', label: '項目', kind: 'number' });
    item.unit = 'mmHg';

    morphItemKind(item, 'select');
    expect(item).toEqual({
      id: 'item',
      label: '項目',
      kind: 'select',
      options: ['選択肢'],
    });

    morphItemKind(item, 'text');
    expect(item).toEqual({ id: 'item', label: '項目', kind: 'text' });
  });
});
