import { ACCOUNT_TYPES, type Account, type AccountType } from '../domain/types';
import type { AccountRole } from '../domain/accountRoles';
import { compareAccountOrder } from '../domain/accountOrder';
import { RECURRING_POSTABLE_ROLES } from '../domain/recurring';
import { accountExistsAt } from '../domain/accountLifetime';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';

export function accountTypeLabel(type: AccountType): string {
  return t(`accounts.type.${type}` as MessageKey);
}

export function accountRoleLabel(role: AccountRole): string {
  return t(`accounts.role.${role}` as MessageKey);
}

export interface AccountGroup {
  type: AccountType;
  label: string;
  accounts: Account[];
}

/**
 * 科目を区分ごとにグループ化する（チップピッカー用）。
 *  - allowedTypes 指定時はそのタイプのみ。
 *  - アーカイブ済みは除外。ただし includeId（編集中の選択値）は型/アーカイブに関わらず残す。
 */
export function groupedAccounts(
  accounts: Account[],
  allowedTypes?: AccountType[],
  includeId?: string,
  atDate?: string,
): AccountGroup[] {
  const types = allowedTypes ?? [...ACCOUNT_TYPES];
  return types
    .map((type) => ({
      type,
      label: accountTypeLabel(type),
      accounts: accounts
        .filter(
          (a) =>
            a.type === type &&
            (atDate === undefined ? !a.archived || a.id === includeId : accountExistsAt(a, atDate)),
        )
        .sort(compareAccountOrder),
    }))
    .filter((g) => g.accounts.length > 0);
}

/**
 * 日常入力用に、許可された役割(role)の科目だけを区分ごとにグループ化する。
 *  - allowedRoles に一致する役割の科目のみ。アーカイブ済みは除外。
 *  - includeId（編集中の選択値）は役割/アーカイブに関わらず残す。
 */
export function groupedAccountsByRole(
  accounts: Account[],
  allowedRoles: AccountRole[],
  includeId?: string,
  atDate?: string,
): AccountGroup[] {
  const allow = new Set(allowedRoles);
  return [...ACCOUNT_TYPES]
    .map((type) => ({
      type,
      label: accountTypeLabel(type),
      accounts: accounts
        .filter(
          (a) =>
            a.type === type &&
            (atDate === undefined
              ? a.id === includeId || (allow.has(a.role) && !a.archived)
              : (a.id === includeId || allow.has(a.role)) && accountExistsAt(a, atDate)),
        )
        .sort(compareAccountOrder),
    }))
    .filter((g) => g.accounts.length > 0);
}

/**
 * 継続コスト資産の「費用の行き先」候補。
 * ユーザーが仕訳先にできる通常科目は会計区分を問わず許可し、内部集約科目と
 * 残高調整科目だけを除外する。編集中の現在値はアーカイブ済みでも残す。
 */
export function monthlyAllocationAccountOptions(
  accounts: Account[],
  includeId?: string,
): { value: string; label: string }[] {
  const allowed = new Set(RECURRING_POSTABLE_ROLES);
  return accounts
    .filter((a) => allowed.has(a.role) && (!a.archived || a.id === includeId))
    .sort(compareAccountOrder)
    .map((a) => ({ value: a.id, label: a.name }));
}

/**
 * 費用の行き先の既定値。候補は全会計区分にまたがるが、既定は必ず費用カテゴリから選ぶ
 * （名前順の先頭が負債科目だと、触らず保存したとき通常の費用計上が負債への振替として
 * 静かに保存されてしまうため）。費用カテゴリが無いときだけ候補の先頭に落とす。
 */
export function defaultMonthlyAllocationAccountId(accounts: Account[]): string {
  const expense = accounts
    .filter((a) => a.role === 'expense-category' && !a.archived)
    .sort(compareAccountOrder)[0];
  if (expense) return expense.id;
  return monthlyAllocationAccountOptions(accounts)[0]?.value ?? '';
}

/**
 * 継続コスト資産の「回収先」候補（アーカイブシート）。
 *
 * 起票できる全 role（簿記入力と同じ流儀）から**費用カテゴリだけを外す**。保存境界は
 * item の費用の行き先以外の費用科目への回収を拒否する（どの費用を打ち消したのかが
 * 台帳から追えないため）ので、選べるのに保存できない行き止まりを作らない。
 * 費用の行き先そのものへ寄せたいときは、シートの「終了日に全額費用にする」を選ぶ。
 * 区分順（資産 → 負債 → …）は ACCOUNT_TYPES が正本なので、資産が先頭に並ぶ。
 */
export function groupedRecoveryDestinationAccounts(
  accounts: Account[],
  includeId?: string,
  atDate?: string,
): AccountGroup[] {
  return groupedAccountsByRole(
    accounts,
    RECURRING_POSTABLE_ROLES.filter((role) => role !== 'expense-category'),
    includeId,
    atDate,
  );
}

/** AccountPicker 用の費用の行き先候補（区分別グループ）。 */
export function groupedMonthlyAllocationAccounts(
  accounts: Account[],
  includeId?: string,
  atDate?: string,
): AccountGroup[] {
  const allowed = new Set(RECURRING_POSTABLE_ROLES);
  return groupedAccountsByRole(
    accounts.filter((account) => allowed.has(account.role)),
    [...RECURRING_POSTABLE_ROLES],
    includeId,
    atDate,
  );
}
