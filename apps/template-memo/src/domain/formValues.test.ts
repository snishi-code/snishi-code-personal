/*
 * フォーム入力値ヘルパ（domain/formValues.ts）のテスト。
 *
 * 要点は provenance 設計: source 欠落 object の推論と、ワンタップ正常チェック
 * （decidePresetToggle）が手入力を絶対に上書き/消去しないこと。
 */

import { describe, expect, it } from 'vitest';
import {
  decidePresetToggle,
  placementHasInput,
  manualTextEntry,
  readEntryNote,
  normalizeTextEntry,
  readPlacementValues,
  readSelectValue,
  readTextValue,
} from './formValues';

const NORMAL = '明らかなラ音なし';

// ============================
// readTextValue / normalizeTextEntry
// ============================

describe('readTextValue', () => {
  it('object なら .value・object 以外（未入力の空文字や null/undefined）は空文字', () => {
    expect(readTextValue({ value: '正常', source: 'manual' })).toBe('正常');
    expect(readTextValue('')).toBe('');
    expect(readTextValue(undefined)).toBe('');
    expect(readTextValue(null)).toBe('');
  });
});

describe('readSelectValue', () => {
  it('現在の選択肢にある TextEntry だけを読む', () => {
    expect(readSelectValue({ value: '精査', source: 'manual' }, ['経過観察', '精査'])).toBe('精査');
    expect(readSelectValue({ value: '旧自由文', source: 'manual' }, ['経過観察', '精査'])).toBe('');
    expect(readSelectValue({ value: '精査', source: 'manual' }, [])).toBe('');
  });
});

describe('normalizeTextEntry の source 判定', () => {
  it('未入力（空文字 / undefined）→ empty', () => {
    expect(normalizeTextEntry('', NORMAL)).toEqual({ value: '', source: 'empty' });
    expect(normalizeTextEntry(undefined, NORMAL)).toEqual({ value: '', source: 'empty' });
  });

  it('明示 source を持つ object は信頼する（normal と同文でも manual のまま）', () => {
    expect(normalizeTextEntry({ value: NORMAL, source: 'manual' }, NORMAL)).toEqual({
      value: NORMAL,
      source: 'manual',
    });
    expect(normalizeTextEntry({ value: NORMAL, source: 'preset' }, NORMAL)).toEqual({
      value: NORMAL,
      source: 'preset',
    });
  });

  it('明示 source があっても value が空なら empty', () => {
    expect(normalizeTextEntry({ value: '', source: 'manual' }, NORMAL)).toEqual({
      value: '',
      source: 'empty',
    });
  });

  it('source 欠落の object は現在の正常文と比較して推論する', () => {
    expect(normalizeTextEntry({ value: NORMAL }, NORMAL)).toEqual({
      value: NORMAL,
      source: 'preset',
    });
    expect(normalizeTextEntry({ value: '手入力' }, NORMAL)).toEqual({
      value: '手入力',
      source: 'manual',
    });
  });
});

// ============================
// decidePresetToggle（ワンタップ正常チェック）
// ============================

describe('decidePresetToggle', () => {
  it('empty → 正常文を preset として書く', () => {
    expect(decidePresetToggle('', NORMAL)).toEqual({
      action: 'write',
      value: { value: NORMAL, source: 'preset' },
    });
  });

  it('preset → クリアする（トグル）', () => {
    expect(decidePresetToggle({ value: NORMAL, source: 'preset' }, NORMAL)).toEqual({
      action: 'clear',
      value: '',
    });
    // source 欠落の object も normal と同文なら preset と推論されクリア
    expect(decidePresetToggle({ value: NORMAL }, NORMAL)).toEqual({ action: 'clear', value: '' });
  });

  it('manual → 手入力を守りエディタへ委ねる', () => {
    expect(decidePresetToggle({ value: '湿性ラ音あり', source: 'manual' }, NORMAL)).toEqual({
      action: 'openEditor',
    });
  });

  it('normal が空のテンプレートでは常に openEditor（空でも write しない）', () => {
    expect(decidePresetToggle('', '')).toEqual({ action: 'openEditor' });
    expect(decidePresetToggle('', undefined)).toEqual({ action: 'openEditor' });
  });
});

describe('manualTextEntry', () => {
  it('空文字は空のまま（provenance を持たせない）', () => {
    expect(manualTextEntry('')).toBe('');
  });

  it('値ありは manual entry', () => {
    expect(manualTextEntry('湿性ラ音あり')).toEqual({ value: '湿性ラ音あり', source: 'manual' });
  });
});

// ============================
// 旧 number / fraction の保存形の引き取り
// ============================

describe('readTextValue（旧保存形の引き取り）', () => {
  it('source を持たない object（旧 number/fraction）も手入力値として引き取る', () => {
    // 種類を text へ畳んだ後に、端末内の既存値が黙って消えないための引き取り。
    expect(readTextValue({ value: '96' })).toBe('96');
    expect(readTextValue({ value: '120/80', note: 'O2 2L' })).toBe('120/80');
  });

  it('object 以外（未入力の空文字 / undefined / 配列）は未入力として読む', () => {
    expect(readTextValue('')).toBe('');
    expect(readTextValue(undefined)).toBe('');
    expect(readTextValue(['96'])).toBe('');
  });
});

describe('readEntryNote', () => {
  it('旧 note を読む・無ければ空文字', () => {
    expect(readEntryNote({ value: '96', note: 'O2 2L' })).toBe('O2 2L');
    expect(readEntryNote({ value: '96' })).toBe('');
    expect(readEntryNote('')).toBe('');
  });
});

describe('manualTextEntry（note の持ち越し）', () => {
  it('note を渡すと保存形に残る（入力 UI は無いが編集で捨てない）', () => {
    expect(manualTextEntry('98', 'O2 2L')).toEqual({
      value: '98',
      source: 'manual',
      note: 'O2 2L',
    });
  });

  it('値を消しても note だけは残る・両方空なら未入力', () => {
    expect(manualTextEntry('', 'O2 2L')).toEqual({ value: '', source: 'manual', note: 'O2 2L' });
    expect(manualTextEntry('', '')).toBe('');
  });
});

// ============================
// readPlacementValues / placementHasInput
// ============================

describe('readPlacementValues', () => {
  const formValues = { g1: { a: '96' } };

  it('該当配置のレコードを返す', () => {
    expect(readPlacementValues(formValues, 'g1')).toEqual({ a: '96' });
  });

  it('配置欠落・formValues 非 object・配列は空 record', () => {
    expect(readPlacementValues(formValues, 'g2')).toEqual({});
    expect(readPlacementValues(undefined, 'g1')).toEqual({});
    expect(readPlacementValues({ g1: ['96'] }, 'g1')).toEqual({});
  });
});

describe('placementHasInput', () => {
  it('value が 1 つでもあれば true', () => {
    expect(placementHasInput({ a: { value: '96' }, b: '' })).toBe(true);
  });

  it('note だけでも true（酸素投与量だけ書いた状態を実入力と数える）', () => {
    expect(placementHasInput({ a: { value: '', note: 'O2 2L' } })).toBe(true);
  });

  it('空・空白のみは false', () => {
    expect(placementHasInput({})).toBe(false);
    expect(placementHasInput({ a: '', b: '  ', c: { value: ' ', note: '' } })).toBe(false);
  });
});
