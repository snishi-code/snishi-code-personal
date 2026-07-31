import { describe, expect, it } from 'vitest';
import {
  normalizeFormat,
  normalizeFrame,
  normalizeTemplateDef,
  type Format,
  type Frame,
} from './entities';

const frame: Frame = {
  id: 'frame-soap',
  name: 'SOAP',
  sections: [
    { id: 'section-s', title: '(S)', freeText: true },
    { id: 'section-o', title: '(O)', freeText: true },
  ],
};

const format: Format = {
  id: 'format-vitals',
  name: 'バイタル',
  joiner: ', ',
  labelSep: ' ',
  titleWrap: '',
  items: [{ id: 'item-bp', label: 'BP', kind: 'fraction', unit: 'mmHg' }],
};

describe('永続化エンティティの正規化', () => {
  it('フレームとフォーマットを防御的に正規化する', () => {
    expect(normalizeFrame(frame)).toEqual(frame);
    expect(normalizeFormat(format)).toEqual(format);
    expect(normalizeFrame({ name: '空', sections: [] })).toBeNull();
    expect(normalizeFormat({ name: '空', items: [] })).toBeNull();
  });

  it('参照カタログを渡すと迷子配置を落とし、迷子フレームは定義ごと拒否する', () => {
    const raw = {
      id: 'template-round',
      name: '回診',
      frameId: frame.id,
      memoSectionId: 'missing-section',
      placements: [
        {
          id: 'placement-ok',
          sectionId: 'section-o',
          formatId: format.id,
          display: 'oncall',
        },
        {
          id: 'placement-missing-section',
          sectionId: 'missing-section',
          formatId: format.id,
        },
        {
          id: 'placement-missing-format',
          sectionId: 'section-o',
          formatId: 'missing-format',
        },
      ],
    };

    expect(normalizeTemplateDef(raw, { frames: [frame], formats: [format] })).toMatchObject({
      memoSectionId: null,
      placements: [
        {
          id: 'placement-ok',
          sectionId: 'section-o',
          formatId: format.id,
          display: 'oncall',
        },
      ],
    });
    expect(
      normalizeTemplateDef(
        { ...raw, frameId: 'missing-frame' },
        { frames: [frame], formats: [format] },
      ),
    ).toBeNull();
  });
});
