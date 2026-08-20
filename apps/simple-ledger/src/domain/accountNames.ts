/*
 * 勘定科目（内訳）名の重複ルール。
 *
 * 内訳名は大きな箱をまたいでも重複不可（別箱の同名は混乱の元）。
 *  - 今日まだ終了していない同名がある → 保存不可（未来の終了点も有効・fail-closed）。
 *  - 今日より前に終了済みの同名がある → ユーザー承認のうえで、終了済み側の末尾に
 *    `（アーカイブ）` / `（アーカイブ2）` … を付けて退避してから保存できる。
 * UI の事前判定と repository の保存境界の両方からこの正本を使う。
 */
import { todayLocal } from '../util/time';
import { accountIsRetiredAt } from './accountLifetime';
import type { Account, JournalEntry } from './types';

/*
 * 「未記入」科目（振り分け前の受け皿。seed の費用科目のひとつ）。
 * まとめて登録の借方を一律ここへ入れ、後から仕訳一覧で振り分ける運用（2026-08-20 作者決定）。
 * 専用フラグ・role は持たず**名前の完全一致（trim 後）だけ**で判定する——
 * 科目を改名すれば未記入扱いから外れる（= 仕様）。判定の正本はこの 2 関数のみ。
 */
export const UNFILLED_ACCOUNT_NAME = '未記入';

/** 科目名が「未記入」か（trim 後の完全一致。部分一致にはしない）。 */
export function isUnfilledAccountName(name: string): boolean {
  return name.trim() === UNFILLED_ACCOUNT_NAME;
}

/** 仕訳の借方または貸方に「未記入」科目が含まれるか（一覧・カードの注意表示に使う）。 */
export function entryHasUnfilledAccount(
  entry: JournalEntry,
  accountsById: Map<string, Account>,
): boolean {
  return entry.lines.some((line) => {
    const name = accountsById.get(line.accountId)?.name;
    return name !== undefined && isUnfilledAccountName(name);
  });
}

export interface AccountNameConflicts {
  /** 基準日にまだ終了していない同名科目。存在すれば保存不可。 */
  active: Account | null;
  /** 基準日より前に終了済みの同名科目（退避リネームの対象）。 */
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
  atDate: string = todayLocal(),
): AccountNameConflicts {
  const trimmed = name.trim();
  const same = accounts.filter((a) => a.id !== excludeId && a.name.trim() === trimmed);
  return {
    active: same.find((a) => !accountIsRetiredAt(a, atDate)) ?? null,
    archived: same.filter((a) => accountIsRetiredAt(a, atDate)),
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
  atDate: string = todayLocal(),
): ArchiveRename[] {
  const { archived } = findAccountNameConflicts(accounts, name, excludeId, atDate);
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
