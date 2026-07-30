import { describe, expect, it } from 'vitest';
import type { TemplateSection } from '../domain/template';
import { partitionSectionGroups } from './ProjectionFormCard';

const section: TemplateSection = {
  id: 'sec',
  title: '場所',
  freeText: false,
  groups: [
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

describe('partitionSectionGroups', () => {
  it('未入力の呼び出し/メニューは入口に置く', () => {
    const result = partitionSectionGroups(section, {});
    expect(result.shown.map((group) => group.id)).toEqual(['always']);
    expect(result.oncall.map((group) => group.id)).toEqual(['oncall']);
    expect(result.menu.map((group) => group.id)).toEqual(['menu']);
  });

  it('値が入った呼び出し/メニューはカードへ昇格し、消すと入口へ戻る', () => {
    const result = partitionSectionGroups(section, {
      oncall: { b: { value: '入力', source: 'manual' } },
      menu: { c: { value: '入力', source: 'manual' } },
    });
    expect(result.shown.map((group) => group.id)).toEqual(['always', 'oncall', 'menu']);
    expect(result.oncall).toEqual([]);
    expect(result.menu).toEqual([]);
  });
});
