import { describe, expect, it } from 'vitest';
import type { TemplateSection } from '../domain/template';
import { partitionSectionPlacements } from './ProjectionFormCard';

const section: TemplateSection = {
  id: 'sec',
  title: '場所',
  freeText: false,
  formats: [
    {
      id: 'always',
      name: '展開',
      display: 'always',
      joiner: '\n',
      labelSep: '：',
      titleWrap: '',
      items: [{ id: 'a', label: 'A', kind: 'text' }],
    },
    {
      id: 'oncall',
      name: '呼び出し',
      display: 'oncall',
      joiner: '\n',
      labelSep: '：',
      titleWrap: '',
      items: [{ id: 'b', label: 'B', kind: 'text' }],
    },
    {
      id: 'menu',
      name: 'メニュー',
      display: 'menu',
      joiner: '\n',
      labelSep: '：',
      titleWrap: '',
      items: [{ id: 'c', label: 'C', kind: 'text' }],
    },
  ],
};

describe('partitionSectionPlacements', () => {
  it('未入力の呼び出し/メニューは入口に置く', () => {
    const result = partitionSectionPlacements(section, {});
    expect(result.shown.map((placement) => placement.id)).toEqual(['always']);
    expect(result.oncall.map((placement) => placement.id)).toEqual(['oncall']);
    expect(result.menu.map((placement) => placement.id)).toEqual(['menu']);
  });

  it('値が入った呼び出し/メニューはカードへ昇格し、消すと入口へ戻る', () => {
    const result = partitionSectionPlacements(section, {
      oncall: { b: { value: '入力', source: 'manual' } },
      menu: { c: { value: '入力', source: 'manual' } },
    });
    expect(result.shown.map((placement) => placement.id)).toEqual(['always', 'oncall', 'menu']);
    expect(result.oncall).toEqual([]);
    expect(result.menu).toEqual([]);
  });
});
