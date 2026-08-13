import { describe, expect, it } from 'vitest';
import {
  normalizeFormat,
  normalizeFrame,
  normalizeTemplateDef,
  type Format,
  type Frame,
} from './entities';
import { buildDailyReportPreset, buildRoundPreset } from './presets';

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
  items: [{ id: 'item-bp', label: 'BP', kind: 'text', unit: 'mmHg' }],
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

  it('見出しも自由本文も無い場所を残す（フォーマットだけを置く場所を保存で消さない）', () => {
    const bare = normalizeFrame({
      id: 'frame-bare',
      name: '骨格のみ',
      sections: [{ id: 'section-bare', title: '', freeText: false }],
    });
    expect(bare?.sections).toEqual([{ id: 'section-bare', title: '', freeText: false }]);
  });

  it('空名を許容し、代替名をデータへ注入しない（titleWrap 合成に混入させない）', () => {
    expect(normalizeFrame({ ...frame, name: '' })?.name).toBe('');
    expect(normalizeFormat({ ...format, name: '' })?.name).toBe('');
    expect(
      normalizeTemplateDef(
        { id: 't', name: '', frameId: frame.id, placements: [] },
        { frames: [frame], formats: [format] },
      )?.name,
    ).toBe('');
  });

  it('配置 ID の重複は先勝ちで落とす（projectedValues キーの共有を防ぐ）', () => {
    const normalized = normalizeTemplateDef(
      {
        id: 'template-dup',
        name: '重複',
        frameId: frame.id,
        placements: [
          { id: 'placement-dup', sectionId: 'section-s', formatId: format.id },
          { id: 'placement-dup', sectionId: 'section-o', formatId: format.id },
        ],
      },
      { frames: [frame], formats: [format] },
    );
    expect(normalized?.placements.map((placement) => placement.sectionId)).toEqual(['section-s']);
  });

  it('showName は false のときだけ持つ（真偽値以外は「見出しを出す」へ倒す）', () => {
    // 入力カードの見出しを消す設定。ここで落とすと「設定できるのに再起動で戻る」挙動になる。
    const of = (showName: unknown) => normalizeFormat({ ...format, showName })?.showName;
    expect(of(false)).toBe(false);
    expect(of(true)).toBeUndefined();
    expect(of(undefined)).toBeUndefined();
    expect(of('false')).toBeUndefined();
    expect(of(0)).toBeUndefined();
  });

  it('旧 kind（number/fraction）の項目を text へ引き取り、単位も残す', () => {
    // 種類を畳んだ後も、既存フォーマット・受信済み共有QR・取り込み JSON の項目が消えない。
    const restored = normalizeFormat({
      ...format,
      items: [
        { id: 'i1', label: 'BP', kind: 'fraction', unit: 'mmHg' },
        { id: 'i2', label: 'SpO2', kind: 'number', unit: '%' },
        { id: 'i3', label: '', kind: 'number' },
      ],
    });
    expect(restored?.items).toEqual([
      { id: 'i1', label: 'BP', kind: 'text', unit: 'mmHg' },
      { id: 'i2', label: 'SpO2', kind: 'text', unit: '%' },
      { id: 'i3', label: '', kind: 'text' },
    ]);
  });

  it('プリセットは正規化の恒等（seed が normalize で欠けない）', () => {
    for (const preset of [buildRoundPreset(1000), buildDailyReportPreset(1000)]) {
      expect(normalizeFrame(preset.frame)).toEqual(preset.frame);
      for (const presetFormat of preset.formats) {
        expect(normalizeFormat(presetFormat)).toEqual(presetFormat);
      }
      expect(
        normalizeTemplateDef(preset.template, {
          frames: [preset.frame],
          formats: preset.formats,
        }),
      ).toEqual(preset.template);
    }
  });
});
