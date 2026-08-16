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

  it('入力 ⇄ 数字は単位も正常文も持ち越す（出るキーボードだけの違い）', () => {
    const item: TemplateItem = {
      id: 'item',
      label: 'BT',
      kind: 'text',
      unit: '℃',
      normal: '37.0未満',
    };

    morphItemKind(item, 'decimal');
    expect(item).toEqual({
      id: 'item',
      label: 'BT',
      kind: 'decimal',
      unit: '℃',
      normal: '37.0未満',
    });

    morphItemKind(item, 'text');
    expect(item).toEqual({
      id: 'item',
      label: 'BT',
      kind: 'text',
      unit: '℃',
      normal: '37.0未満',
    });
  });

  it('数字 → 選択 は専用フィールドを捨てる（select を跨ぐときだけ初期化）', () => {
    const item: TemplateItem = { id: 'item', label: 'BT', kind: 'decimal', unit: '℃' };

    morphItemKind(item, 'select');
    expect(item).toEqual({ id: 'item', label: 'BT', kind: 'select', options: ['選択肢'] });
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
