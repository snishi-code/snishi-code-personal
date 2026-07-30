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

  it('number↔fraction の切替は単位を引き継ぐ', () => {
    const item: TemplateItem = { id: 'item', label: 'BP', kind: 'number', unit: 'mmHg' };

    morphItemKind(item, 'fraction');
    expect(item).toEqual({ id: 'item', label: 'BP', kind: 'fraction', unit: 'mmHg' });

    morphItemKind(item, 'number');
    expect(item).toEqual({ id: 'item', label: 'BP', kind: 'number', unit: 'mmHg' });

    // 数値系以外へ抜けるときは単位ごと捨てる。
    morphItemKind(item, 'text');
    expect(item).toEqual({ id: 'item', label: 'BP', kind: 'text' });
  });

  it('未知の kind は無変更 (DOM 由来値の fail-closed)', () => {
    const item: TemplateItem = { id: 'item', label: '項目', kind: 'text', normal: '正常' };

    morphItemKind(item, 'bogus' as never);
    expect(item).toEqual({ id: 'item', label: '項目', kind: 'text', normal: '正常' });
  });
});
