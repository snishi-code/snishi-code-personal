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
  normalizeTextEntry,
  numericEntry,
  readPlacementValues,
  readNumericEntry,
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

  it('source の無い数値形は kind 変更の残骸として落とす', () => {
    expect(readTextValue({ value: '96' })).toBe('');
  });
});

describe('readSelectValue', () => {
  it('現在の選択肢にある TextEntry だけを読む', () => {
    expect(readSelectValue({ value: '精査', source: 'manual' }, ['経過観察', '精査'])).toBe('精査');
    expect(readSelectValue({ value: '旧自由文', source: 'manual' }, ['経過観察', '精査'])).toBe('');
    expect(readSelectValue({ value: '96' }, ['96'])).toBe('');
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
// readNumericEntry / numericEntry
// ============================

describe('readNumericEntry', () => {
  it('object は value と note を読む・欠落フィールドは空文字', () => {
    expect(readNumericEntry({ value: '96', note: 'O2 2L' })).toEqual({
      value: '96',
      note: 'O2 2L',
    });
    expect(readNumericEntry({ value: '96' })).toEqual({ value: '96', note: '' });
  });

  it('object 以外（未入力の空文字 / undefined）は未入力として読む', () => {
    expect(readNumericEntry('')).toEqual({ value: '', note: '' });
    expect(readNumericEntry(undefined)).toEqual({ value: '', note: '' });
  });

  it('source 付き text/select 形は kind 変更の残骸として落とす', () => {
    expect(readNumericEntry({ value: '精査', source: 'manual' })).toEqual({
      value: '',
      note: '',
    });
  });
});

describe('numericEntry', () => {
  it('両方空なら空文字（未入力）', () => {
    expect(numericEntry('', '')).toBe('');
  });

  it('note 無しは { value } のみ・note ありは両方持つ', () => {
    expect(numericEntry('96', '')).toEqual({ value: '96' });
    expect(numericEntry('96', 'O2 2L')).toEqual({ value: '96', note: 'O2 2L' });
  });

  it('値なし注記だけでも保存形は作る（出力抑制は composeItem 側の責務）', () => {
    expect(numericEntry('', 'O2 2L')).toEqual({ value: '', note: 'O2 2L' });
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
