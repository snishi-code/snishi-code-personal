import { ACCOUNT_TYPES, type Account, type AccountType } from '../domain/types';
import type { AccountRole } from '../domain/accountRoles';
import { compareAccountOrder } from '../domain/accountOrder';
import { RECURRING_POSTABLE_ROLES } from '../domain/recurring';
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
): AccountGroup[] {
  const types = allowedTypes ?? [...ACCOUNT_TYPES];
  return types
    .map((type) => ({
      type,
      label: accountTypeLabel(type),
      accounts: accounts
        .filter((a) => a.type === type && (!a.archived || a.id === includeId))
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
): AccountGroup[] {
  const allow = new Set(allowedRoles);
  return [...ACCOUNT_TYPES]
    .map((type) => ({
      type,
      label: accountTypeLabel(type),
      accounts: accounts
        .filter((a) => a.type === type && (a.id === includeId || (allow.has(a.role) && !a.archived)))
        .sort(compareAccountOrder),
    }))
    .filter((g) => g.accounts.length > 0);
}

/**
 * 継続コストの認識先候補。
 * ユーザーが仕訳先にできる通常科目は会計区分を問わず許可し、内部集約科目と
 * 残高調整科目だけを除外する。編集中の現在値はアーカイブ済みでも残す。
 */
export function recognitionAccountOptions(
  accounts: Account[],
  includeId?: string,
): { value: string; label: string }[] {
  const allowed = new Set(RECURRING_POSTABLE_ROLES);
  return accounts
    .filter((a) => allowed.has(a.role) && (!a.archived || a.id === includeId))
    .sort(compareAccountOrder)
    .map((a) => ({ value: a.id, label: a.name }));
}

/** AccountPicker 用の認識先候補（区分別グループ）。 */
export function groupedRecognitionAccounts(
  accounts: Account[],
  includeId?: string,
): AccountGroup[] {
  const allowed = new Set(RECURRING_POSTABLE_ROLES);
  return groupedAccountsByRole(
    accounts.filter((account) => allowed.has(account.role)),
    [...RECURRING_POSTABLE_ROLES],
    includeId,
  );
}
