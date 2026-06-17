/*
 * 仕訳 1 件の一覧行。摘要・借方→貸方・日付・金額を示す。
 */
import { useMemo } from 'react';
import type { Account, JournalEntry } from '../domain/types';
import { Money } from './money';
import { t } from '../i18n';

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
  const amount = debit?.amount ?? credit?.amount ?? 0;
  // 「お金の流れ」は全画面で 源泉(credit) → 行き先(debit) に統一する。
  const flow = `${accountName(map, credit?.accountId ?? '')} → ${accountName(
    map,
    debit?.accountId ?? '',
  )}`;

  const content = (
    <>
      <div className="list__main">
        <div className="list__title">
          {entry.kind === 'opening' ? (
            <span className="tag tag--neutral">{t('journal.opening')}</span>
          ) : null}{' '}
          {entry.description}
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
        <button type="button" className="list__item" onClick={onClick} style={{ width: '100%' }}>
          {content}
        </button>
      </li>
    );
  }
  return <li className="list__item">{content}</li>;
}
