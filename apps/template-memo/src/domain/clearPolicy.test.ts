/*
 * ラウンド開始クリアの固定ポリシー（domain/clearPolicy.ts）の単体テスト。
 *
 * とくにタグ: 色 = 「ラウンド開始で外れるか」。色の解決は呼び出し側（HomeView.runClear）が
 * roundStartClearTagNames で行い、この関数へは「外すタグ名の集合」だけが渡る。
 * ここでは集合の扱い（外す / 残す / 孤児名）と、他のクリア対象が不変であることを縛る。
 */

import { describe, expect, it } from 'vitest';
import { applyRoundStartClear } from './clearPolicy';
import { roundStartClearTagNames } from './tags';
import { makeDefaultPatient } from './normalize';
import { STATUS, type Patient, type PatientStatus, type TagDef } from './types';

const TAG_DEFS: TagDef[] = [
  { name: '継続', color: 'blue' },
  { name: '今回', color: 'amber' },
];

function patientWith(over: Partial<Patient> = {}): Patient {
  return { ...makeDefaultPatient(), ...over };
}

describe('applyRoundStartClear（タグ）', () => {
  it('青のタグは残る', () => {
    const p = patientWith({ tags: ['継続'] });
    applyRoundStartClear(p, 1000, roundStartClearTagNames(TAG_DEFS));
    expect(p.tags).toEqual(['継続']);
  });

  it('青以外の色のタグは外れる', () => {
    const p = patientWith({ tags: ['継続', '今回'] });
    applyRoundStartClear(p, 1000, roundStartClearTagNames(TAG_DEFS));
    expect(p.tags).toEqual(['継続']);
  });

  it('定義に無い孤児タグ名は残る（安全側）', () => {
    const p = patientWith({ tags: ['今回', '旧タグ'] });
    applyRoundStartClear(p, 1000, roundStartClearTagNames(TAG_DEFS));
    expect(p.tags).toEqual(['旧タグ']);
  });

  it('外すタグが 1 つも無ければタグ列はそのまま', () => {
    const p = patientWith({ tags: ['継続', '旧タグ'] });
    applyRoundStartClear(p, 1000, new Set<string>());
    expect(p.tags).toEqual(['継続', '旧タグ']);
  });

  it('tags が配列でない壊れ値でも throw しない（fail-safe）', () => {
    const p = patientWith({ tags: undefined as unknown as string[] });
    expect(() => applyRoundStartClear(p, 1000, roundStartClearTagNames(TAG_DEFS))).not.toThrow();
  });
});

describe('applyRoundStartClear（タグ以外は不変のまま）', () => {
  it('status は黄/緑/灰だけ none へ戻し、青と白は据え置く', () => {
    const cases: [PatientStatus, PatientStatus][] = [
      [STATUS.YELLOW, STATUS.NONE],
      [STATUS.GREEN, STATUS.NONE],
      [STATUS.GRAY, STATUS.NONE],
      [STATUS.BLUE, STATUS.BLUE],
      [STATUS.NONE, STATUS.NONE],
    ];
    for (const [before, after] of cases) {
      const p = patientWith({ status: before });
      applyRoundStartClear(p, 1000, roundStartClearTagNames(TAG_DEFS));
      expect(p.status).toBe(after);
    }
  });

  it('自由本文 / フォーム値は消し、問題リスト / 継続メモ / 名前 / 位置は残す', () => {
    const p = patientWith({
      name: '対象A',
      room: '101',
      tags: ['今回'],
      problems: ['HF', 'DM'],
      sectionTexts: { sec_o: '今回の観察メモ' },
      standingMemo: '週明けLabo',
      projectedValues: { plc_v: { itm_bp: { value: '120/80' } } },
      updatedAt: 1000,
    });
    applyRoundStartClear(p, 2000, roundStartClearTagNames(TAG_DEFS));

    expect(p.sectionTexts).toEqual({});
    expect(p.projectedValues).toEqual({});
    expect(p.problems).toEqual(['HF', 'DM']);
    expect(p.standingMemo).toBe('週明けLabo');
    expect(p.name).toBe('対象A');
    expect(p.room).toBe('101');
    // updatedAt は前進する（nextGroupRevision）。
    expect(p.updatedAt).toBeGreaterThan(1000);
  });
});
