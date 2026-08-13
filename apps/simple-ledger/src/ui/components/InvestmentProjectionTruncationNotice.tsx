/*
 * 投資利回りの投影が算術限界で止まったことを、投影を表示する全画面で同じ文言で名乗る。
 * 診断は表示専用であり、保存判断へは合流させない。
 */
import type { InvestmentProjectionTruncation } from '../../domain/investmentProjection';
import type { Account } from '../../domain/types';
import { t } from '../../i18n';

export function InvestmentProjectionTruncationNotice({
  truncations,
  accounts,
  dataUi,
}: {
  truncations: readonly InvestmentProjectionTruncation[];
  accounts: readonly Account[];
  dataUi?: string;
}) {
  const accountNames = new Map(accounts.map((account) => [account.id, account.name] as const));
  // 同じ科目を複数の集計バケットで展開した場合も、打ち切りは一度だけ伝える。
  const unique = new Map<string, InvestmentProjectionTruncation>();
  for (const truncation of truncations) {
    const previous = unique.get(truncation.accountId);
    if (!previous || truncation.month < previous.month) {
      unique.set(truncation.accountId, truncation);
    }
  }

  return (
    <>
      {[...unique.values()].map((truncation) => (
        <p
          className="field__hint"
          role="note"
          key={truncation.accountId}
          {...(dataUi === undefined ? {} : { 'data-ui': dataUi })}
        >
          {t('projection.truncatedNotice', {
            name: accountNames.get(truncation.accountId) ?? '—',
            month: truncation.month,
          })}
        </p>
      ))}
    </>
  );
}
