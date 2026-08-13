// 患者データの正規化（コピー元: hospital-workspace/rounds/domain/normalize.ts を
// template-memo モデルへ剥離。ユーザー/役割/roster/次回診察日/AI の次元は持たない）。
//
// 方針: **型不一致 → デフォルトに倒す**。未知フィールドは破棄し、
// 明示フィールドのみで正規化結果を組み立てる。

import { newId } from '../data/constants';
import { STATUS, isPatientStatus, type FormValues, type Patient } from './types';
import { problemsHaveInput } from './problems';

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

export function makeDefaultPatient(): Patient {
  return {
    pid: newId('pat'),
    status: STATUS.NONE,
    name: '',
    room: '',
    placeId: '',
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

/** projectedValues（FormValues）の外側 2 層だけを正規化する。値の形は読み出しヘルパに委ねる。 */
export function normalizeProjectedValues(raw: unknown): FormValues {
  if (!isRecord(raw)) return {};
  const out: FormValues = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isRecord(v) && !Array.isArray(v)) out[k] = { ...v };
  }
  return out;
}

/**
 * 場所ごとの自由本文（sectionTexts）の正規化。plain object の string 値エントリだけを残す
 * （非文字列・配列・入れ子は捨てる）。projectedValues と同じ薄い whitelist。
 */
export function normalizeSectionTexts(raw: unknown): Record<string, string> {
  if (!isRecord(raw) || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** sectionTexts に trim 非空の本文が 1 つでもあるか。 */
function hasSectionText(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  return Object.values(raw).some((v) => typeof v === 'string' && v.trim() !== '');
}

/**
 * 「空患者」= 追加した直後の未入力スロット相当: ステータスが NONE (白) で、かつ name/room/
 * tags/problems/場所ごとの自由本文/継続メモ/フォーム値 がすべて初期値 (pid と updatedAt は無視)。
 * YELLOW/GREEN/BLUE/GRAY はユーザーが明示的にステータスを付けた状態なので削除対象外。
 */
export function isPatientEmpty(p: Patient | null | undefined): boolean {
  if (!p) return false;
  if (p.status !== STATUS.NONE) return false;
  if (p.name) return false;
  if (p.room) return false;
  if (Array.isArray(p.tags) && p.tags.length > 0) return false;
  if (problemsHaveInput(p.problems)) return false;
  if (hasSectionText(p.sectionTexts)) return false;
  if (typeof p.standingMemo === 'string' && p.standingMemo.trim() !== '') return false;
  if (p.projectedValues && Object.keys(p.projectedValues).length > 0) return false;
  return true;
}

export function normalizePatientArray(arr: readonly unknown[] | null | undefined): Patient[] {
  const len = arr && arr.length ? arr.length : 0;
  const out = new Array<Patient>(len);
  for (let i = 0; i < len; i++) {
    const rawEntry = arr ? arr[i] : null;
    const r: Record<string, unknown> | null = isRecord(rawEntry) ? rawEntry : null;
    const d = makeDefaultPatient();
    out[i] = {
      pid: r && typeof r.pid === 'string' && r.pid ? r.pid : d.pid,
      status: r && isPatientStatus(r.status) ? r.status : d.status,
      name: r && typeof r.name === 'string' ? r.name : d.name,
      room: r && typeof r.room === 'string' ? r.room : d.room,
      placeId: r && typeof r.placeId === 'string' ? r.placeId : d.placeId,
      tags:
        r && Array.isArray(r.tags)
          ? r.tags
              .filter((t): t is string => typeof t === 'string' && !!t.trim())
              .map((t) => String(t))
          : [],
      problems:
        r && Array.isArray(r.problems)
          ? r.problems.filter((x): x is string => typeof x === 'string')
          : [],
      standingMemo: r && typeof r.standingMemo === 'string' ? r.standingMemo : '',
      templateId: r && typeof r.templateId === 'string' ? r.templateId : '',
      // ※ ここに追加しないと whitelist で reload 時に黙って消える。
      sectionTexts: normalizeSectionTexts(r ? r.sectionTexts : undefined),
      projectedValues: normalizeProjectedValues(r ? r.projectedValues : undefined),
      updatedAt: r && typeof r.updatedAt === 'number' ? r.updatedAt : 0,
      archivedAt: r && typeof r.archivedAt === 'number' ? r.archivedAt : null,
    };
  }
  return out;
}
