/*
 * 仕訳 1 件の一覧行。摘要・借方→貸方・日付・金額を示す。
 */
import { useMemo } from 'react';
import type { Account, JournalEntry } from '../domain/types';
import { representativeEntryAmount } from '../domain/accounting';
import { entryHasUnfilledAccount } from '../domain/accountNames';
import { Money } from './money';
import { t } from '../i18n';
import { UI } from '../ui-contract';

function accountName(map: Map<string, Account>, id: string): string {
  return map.get(id)?.name ?? '—';
}

export function EntryListItem({
  entry,
  accounts,
  currency,
  onClick,
}: {
  entry: JournalEntry;
  accounts: Account[];
  currency: string;
  onClick?: () => void;
}) {
  const map = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const debit = entry.lines.find((l) => l.side === 'debit');
  const credit = entry.lines.find((l) => l.side === 'credit');
  // 仕訳の代表額は domain が正本（式を UI で書き直さない）。render から呼ぶので投げない方。
  const amount = representativeEntryAmount(entry);
  // 「お金の流れ」は全画面で 源泉(credit) → 行き先(debit) に統一する。
  const flow = `${accountName(map, credit?.accountId ?? '')} → ${accountName(
    map,
    debit?.accountId ?? '',
  )}`;

  // 借方/貸方が「未記入」科目のまま（振り分け前）。仕訳一覧と同じ淡色 + チップ。
  const isUnfilled = entryHasUnfilledAccount(entry, map);
  const itemClass = `list__item${isUnfilled ? ' list__item--unfilled' : ''}`;

  const content = (
    <>
      <div className="list__main">
        <div className="list__title">
          {entry.kind === 'opening' ? (
            <span className="tag tag--neutral">{t('journal.opening')}</span>
          ) : null}{' '}
          {entry.description}{' '}
          {isUnfilled ? (
            <span className="tag tag--unfilled">{t('journal.unfilledTag')}</span>
          ) : null}{' '}
          {entry.groupId !== undefined ? (
            // 諸口（同一 groupId の束）の目印（v13.16）。色の意味論は増やさない（中立トークン）。
            // 集計・抽出には一切効かない = ただの目印（グループに不変条件を持たせない合意）。
            <span className="tag tag--neutral" data-ui={UI.journal.groupTag}>
              {t('journal.groupTag')}
              <span className="sr-only">{t('journal.groupTagSr')}</span>
            </span>
          ) : null}
        </div>
        <div className="list__sub">
          {entry.date}・{flow}
        </div>
      </div>
      <span className="list__amount">
        <Money amount={amount} currency={currency} />
      </span>
    </>
  );

  if (onClick) {
    return (
      <li>
        <button type="button" className={itemClass} onClick={onClick} style={{ width: '100%' }}>
          {content}
        </button>
      </li>
    );
  }
  return <li className={itemClass}>{content}</li>;
}
