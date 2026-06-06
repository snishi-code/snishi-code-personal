import { ACCOUNT_TYPES, type Account, type AccountType } from '../domain/types';
import type { AccountRole } from '../domain/accountRoles';
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
      accounts: accounts.filter((a) => a.type === type && (!a.archived || a.id === includeId)),
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
      accounts: accounts.filter(
        (a) => a.type === type && (a.id === includeId || (allow.has(a.role) && !a.archived)),
      ),
    }))
    .filter((g) => g.accounts.length > 0);
}
