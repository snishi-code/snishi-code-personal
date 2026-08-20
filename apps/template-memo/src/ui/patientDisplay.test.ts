/*
 * 位置 (room) の入力と並び順のテスト。
 *
 * 位置は自由文字列で、数字限定にはしない (A012・A-01 のような表記を通す)。
 * そのぶん比較器が数字混じりを人間の期待どおりに並べること、掃除が値を破壊しないことを固定する。
 */

import { describe, expect, it } from 'vitest';
import {
  ensurePatientOrder,
  formatPatientLabel,
  patientLabelParts,
  patientRoomCompare,
  sanitizeRoomInput,
} from './patientDisplay';
import { STATUS, type Patient } from '../domain/types';

function patient(pid: string, room: string): Patient {
  return {
    pid,
    status: STATUS.NONE,
    name: pid,
    room,
    placeId: 'pl',
    tags: [],
    problems: [],
    sectionTexts: {},
    standingMemo: '',
    templateId: '',
    projectedValues: {},
    updatedAt: 0,
    archivedAt: null,
  };
}

describe('sanitizeRoomInput', () => {
  it('英数字・記号を落とさない（A012 が入力できる）', () => {
    expect(sanitizeRoomInput('A012')).toBe('A012');
    expect(sanitizeRoomInput('A-01')).toBe('A-01');
    expect(sanitizeRoomInput('3F-12')).toBe('3F-12');
    expect(sanitizeRoomInput('101')).toBe('101');
  });

  it('改行・タブ・制御文字だけを落とす（貼り付けで一覧の 1 行表示が壊れないため）', () => {
    expect(sanitizeRoomInput('A0\n12')).toBe('A012');
    expect(sanitizeRoomInput('A0\t12\r')).toBe('A012');
  });

  it('非文字列は空文字へ倒す', () => {
    expect(sanitizeRoomInput(undefined as unknown as string)).toBe('');
  });
});

describe('patientLabelParts / formatPatientLabel', () => {
  it('番号と名前を別部品で返し、結合ラベルと一致する（名簿の列描画と読み上げがずれない）', () => {
    const p = { ...patient('p1', '101'), name: '検証対象A' };
    expect(patientLabelParts(p, '1')).toEqual({ room: '101', name: '検証対象A' });
    expect(formatPatientLabel(p, '1')).toBe('101 検証対象A');
  });

  it('位置は前後空白を落とし、未入力は空文字（結合ラベルに余計な区切りを入れない）', () => {
    const p = { ...patient('p1', ' 101 '), name: '検証対象A' };
    expect(patientLabelParts(p, '1').room).toBe('101');
    const noRoom = { ...patient('p2', ''), name: '検証対象B' };
    expect(patientLabelParts(noRoom, '2')).toEqual({ room: '', name: '検証対象B' });
    expect(formatPatientLabel(noRoom, '2')).toBe('検証対象B');
  });

  it('名前未入力は fallback（通し番号）へ倒す', () => {
    const p = { ...patient('p1', '101'), name: '' };
    expect(patientLabelParts(p, '7')).toEqual({ room: '101', name: '7' });
    expect(patientLabelParts(null, '7')).toEqual({ room: '', name: '7' });
  });
});

describe('patientRoomCompare', () => {
  const cmp = (a: string, b: string) => patientRoomCompare(patient('a', a), patient('b', b));

  it('数字は桁数ではなく数値の順に並ぶ', () => {
    expect(cmp('9', '101')).toBeLessThan(0);
    expect(cmp('101', '9')).toBeGreaterThan(0);
  });

  it('英字混じりも数値部分で並ぶ（A2 < A10。素の辞書順では逆になる）', () => {
    expect(cmp('A2', 'A10')).toBeLessThan(0);
    expect(cmp('101A', '101B')).toBeLessThan(0);
  });

  it('位置未入力は末尾へ回す', () => {
    expect(cmp('', '101')).toBeGreaterThan(0);
    expect(cmp('101', '')).toBeLessThan(0);
    expect(cmp('', '')).toBe(0);
  });

  it('反対称性: sign(cmp(a,b)) === -sign(cmp(b,a))', () => {
    const rooms = ['101', '9', '101A', '101B', 'A012', 'A-01', '', ' '];
    // Object.is は -0 と +0 を区別するので、符号だけを見るため 0 へ正規化する。
    const sign = (n: number) => Math.sign(n) || 0;
    for (const a of rooms) {
      for (const b of rooms) {
        expect(sign(cmp(a, b))).toBe(sign(-cmp(b, a)));
      }
    }
  });
});

describe('ensurePatientOrder', () => {
  it('位置順に並べ、未入力は末尾に置く', () => {
    const list = [patient('p1', ''), patient('p2', 'A10'), patient('p3', '9'), patient('p4', 'A2')];
    ensurePatientOrder(list);
    expect(list.map((p) => p.pid)).toEqual(['p3', 'p4', 'p2', 'p1']);
  });

  it('同着（位置未入力どうし）は追加した順を保つ', () => {
    // Array#sort は安定。id 等で無理に決着させると、ユーザーに読めない並びになる。
    const list = [patient('p1', ''), patient('p2', ''), patient('p3', '')];
    ensurePatientOrder(list);
    expect(list.map((p) => p.pid)).toEqual(['p1', 'p2', 'p3']);
  });
});
