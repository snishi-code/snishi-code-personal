import { ACCOUNT_TYPES, type Account, type AccountType } from '../domain/types';
import type { OptionGroup } from './Field';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';

export function accountTypeLabel(type: AccountType): string {
  return t(`accounts.type.${type}` as MessageKey);
}

/** 借方/貸方の選択肢を勘定区分でグループ化する。アーカイブ済みは除外。 */
export function groupedAccountOptions(accounts: Account[]): OptionGroup[] {
  const active = accounts.filter((a) => !a.archived);
  return ACCOUNT_TYPES.map((type) => ({
    label: accountTypeLabel(type),
    options: active.filter((a) => a.type === type).map((a) => ({ value: a.id, label: a.name })),
  })).filter((g) => g.options.length > 0);
}
