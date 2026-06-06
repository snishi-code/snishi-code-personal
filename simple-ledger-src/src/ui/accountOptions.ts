import { ACCOUNT_TYPES, type Account, type AccountType } from '../domain/types';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';

export function accountTypeLabel(type: AccountType): string {
  return t(`accounts.type.${type}` as MessageKey);
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
