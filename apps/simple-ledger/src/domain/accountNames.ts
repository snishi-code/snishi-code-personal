/*
 * 勘定科目（内訳）名の重複ルール。
 *
 * 内訳名は大きな箱をまたいでも重複不可（別箱の同名は混乱の元）。
 *  - 有効（非アーカイブ）な同名がある → 保存不可（fail-closed）。
 *  - アーカイブ済みの同名がある → ユーザー承認のうえで、アーカイブ側の末尾に
 *    `（アーカイブ）` / `（アーカイブ2）` … を付けて退避してから保存できる。
 * UI の事前判定と repository の保存境界の両方からこの正本を使う。
 */
import type { Account } from './types';

export interface AccountNameConflicts {
  /** 有効（非アーカイブ）な同名科目。存在すれば保存不可。 */
  active: Account | null;
  /** アーカイブ済みの同名科目（退避リネームの対象）。 */
  archived: Account[];
}

/**
 * trimmed 完全一致で同名科目を探す（excludeId は自分自身の更新を除外する）。
 * 入力・保存済みの両側を trim して比較するため、保存値に空白が混じっても
 * （import 等で持ち込まれた場合でも）「預金」と「預金 」を同名として扱える。
 */
export function findAccountNameConflicts(
  accounts: Account[],
  name: string,
  excludeId?: string,
): AccountNameConflicts {
  const trimmed = name.trim();
  const same = accounts.filter((a) => a.id !== excludeId && a.name.trim() === trimmed);
  return {
    active: same.find((a) => !a.archived) ?? null,
    archived: same.filter((a) => a.archived),
  };
}

/** アーカイブ退避名の候補列: 名前（アーカイブ）, 名前（アーカイブ2）, … */
function archivedNameCandidate(base: string, n: number): string {
  return n <= 1 ? `${base}（アーカイブ）` : `${base}（アーカイブ${n}）`;
}

export interface ArchiveRename {
  account: Account;
  newName: string;
}

/**
 * アーカイブ済みの同名科目を退避するためのリネーム計画。
 * 既存の全科目名・計画済みの新名と衝突しない名前を順に割り当てる。
 */
export function planArchiveRenames(
  accounts: Account[],
  name: string,
  excludeId?: string,
): ArchiveRename[] {
  const { archived } = findAccountNameConflicts(accounts, name, excludeId);
  if (archived.length === 0) return [];
  const used = new Set(accounts.map((a) => a.name));
  const plans: ArchiveRename[] = [];
  let n = 1;
  for (const account of archived) {
    let candidate = archivedNameCandidate(name.trim(), n);
    while (used.has(candidate)) {
      n += 1;
      candidate = archivedNameCandidate(name.trim(), n);
    }
    used.add(candidate);
    n += 1;
    plans.push({ account, newName: candidate });
  }
  return plans;
}
