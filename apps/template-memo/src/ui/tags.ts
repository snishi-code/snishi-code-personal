// 個人タグの正本は settings.tags。患者側は patient.tags (名前参照)。
// (コピー元: hospital-workspace/rounds/ui/tags.ts。共有タグ・担当者 (userAssignments)・
//  「自分の担当」フィルタの次元は剥離 = 単一タグ化)
//
// タグフィルタはモジュールレベル状態 (アプリ起動中のみ保持)。
// 変更後の再描画は呼び出し側が runtime.bump() で行う。
// フィルタは個人タグの全タグ一致 (AND) 固定。

import { type Patient, type AppSettings, type TagColor } from '../domain/types';
import { DEFAULT_TAG_COLOR } from '../domain/tags';
import type { HrStore } from '../data/store';

// ============================
// クエリ
// ============================

/** 個人タグ名一覧 (settings.tags / TagDef[] → string[])。 */
export function getAllTags(settings: AppSettings): string[] {
  return Array.isArray(settings.tags)
    ? settings.tags.map((t) => t.name).filter((n) => n.trim())
    : [];
}

/** 患者の絞り込み対象タグ (個人タグ・名前重複は排除)。 */
function patientFilterableTags(p: Patient): string[] {
  const personal = Array.isArray(p.tags) ? p.tags : [];
  const out: string[] = [];
  for (const name of personal) if (name && !out.includes(name)) out.push(name);
  return out;
}

// ============================
// タグ CRUD (設定 + アクティブビュー患者への波及)。保存は caller の責務に
// しない — ここで saveSettings / scheduleSave まで行う。
// ============================

/**
 * 新規の個人タグ追加 (重複は false)。color は「ラウンド開始で外れるか」を決める
 * (domain/tags.ts)。既定は残る側 = 付け忘れたタグが黙って消えない安全側。
 * 色はあとから設定のタグ管理で変更できる。
 */
export function addNewTag(
  store: HrStore,
  name: string,
  color: TagColor = DEFAULT_TAG_COLOR,
): boolean {
  const trimmed = String(name || '').trim();
  if (!trimmed) return false;
  const settings = store.getSettings();
  if (!Array.isArray(settings.tags)) settings.tags = [];
  if (settings.tags.some((t) => t.name === trimmed)) return false;
  settings.tags.push({ name: trimmed, color });
  void store.saveSettings();
  return true;
}

/** idx のタグを改名し、アクティブビューの患者タグも同名置換する。重複は false。 */
export function renameTagAt(store: HrStore, idx: number, newName: string): boolean {
  const settings = store.getSettings();
  if (!Array.isArray(settings.tags) || idx < 0 || idx >= settings.tags.length) return false;
  const oldName = settings.tags[idx]!.name;
  const next = String(newName || '').trim();
  if (!next) return false;
  if (oldName === next) return true;
  if (settings.tags.some((t) => t.name === next)) return false;
  settings.tags[idx]!.name = next;
  for (const p of store.getAppState().patients) {
    if (Array.isArray(p.tags)) p.tags = p.tags.map((tg) => (tg === oldName ? next : tg));
  }
  void store.saveSettings();
  store.scheduleSave();
  return true;
}

/** idx のタグを削除し、アクティブビューの患者からも外す。 */
export function deleteTagAt(store: HrStore, idx: number): void {
  const settings = store.getSettings();
  if (!Array.isArray(settings.tags) || idx < 0 || idx >= settings.tags.length) return;
  const name = settings.tags[idx]!.name;
  settings.tags.splice(idx, 1);
  for (const p of store.getAppState().patients) {
    if (Array.isArray(p.tags) && p.tags.includes(name)) {
      p.tags = p.tags.filter((tg) => tg !== name);
    }
  }
  void store.saveSettings();
  store.scheduleSave();
}

/**
 * idx のタグの color を変更する (= ラウンド開始で外れるかを切り替える)。
 * 色の変更は設定のタグ管理でのみ行う。
 */
export function setTagColor(store: HrStore, idx: number, color: TagColor): void {
  const settings = store.getSettings();
  if (!Array.isArray(settings.tags) || idx < 0 || idx >= settings.tags.length) return;
  settings.tags[idx]!.color = color;
  void store.saveSettings();
}

/**
 * タグ名から TagColor を解決する。settings.tags に登録されていれば color を返す。
 * 見つからない (孤児タグ名) 場合は既定色 = 残る側にフォールバックし、
 * ラウンド開始でも外れない扱いと表示を一致させる。
 */
export function tagColorOf(settings: AppSettings, name: string): TagColor {
  if (Array.isArray(settings.tags)) {
    const def = settings.tags.find((t) => t.name === name);
    if (def) return def.color;
  }
  return DEFAULT_TAG_COLOR;
}

// ============================
// ホームタグフィルタ状態 (アプリ起動中のみ保持)
// ============================

let _homeTagFilter: string[] = [];

export function getHomeTagFilter(): string[] {
  return _homeTagFilter.slice();
}
export function setHomeTagFilter(tags: string[]): void {
  _homeTagFilter = tags.slice();
}

/** 選択タグをすべて持つ患者だけ表示する (AND 固定)。 */
export function patientMatchesTagFilter(p: Patient): boolean {
  if (!_homeTagFilter.length) return true;
  const have = new Set(patientFilterableTags(p));
  return _homeTagFilter.every((tg) => have.has(tg));
}
