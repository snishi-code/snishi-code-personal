/*
 * 仕訳一覧。検索（摘要・メモ）と期間絞り込み、行タップで編集、削除は明示確認。
 */
import { useMemo, useState } from 'react';
import { useLedger } from '../../state/store';
import { Money } from '../money';
import { Icon } from '../Icon';
import { ConfirmDialog } from '../ConfirmDialog';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { Account, JournalEntry } from '../../domain/types';

function flowText(map: Map<string, Account>, entry: JournalEntry): string {
  const debit = entry.lines.find((l) => l.side === 'debit');
  const credit = entry.lines.find((l) => l.side === 'credit');
  const name = (id?: string) => (id ? (map.get(id)?.name ?? '—') : '—');
  return `${name(debit?.accountId)} → ${name(credit?.accountId)}`;
}

export function Journal({ onEditEntry }: { onEditEntry: (entry: JournalEntry) => void }) {
  const { ledger, removeEntry } = useLedger();
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pendingDelete, setPendingDelete] = useState<JournalEntry | null>(null);

  const map = useMemo(() => new Map((ledger?.accounts ?? []).map((a) => [a.id, a])), [ledger]);
  const currency = ledger?.settings.currency ?? 'JPY';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (ledger?.journalEntries ?? []).filter((e) => {
      if (from && e.date < from) return false;
      if (to && e.date > to) return false;
      if (q) {
        const hay = `${e.description} ${e.memo ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [ledger, query, from, to]);

  const hasFilter = query !== '' || from !== '' || to !== '';

  return (
    <section aria-labelledby="journal-title" data-ui={UI.journal.view}>
      <h1 className="screen-title" id="journal-title">
        {t('journal.title')}
      </h1>

      <div className="toolbar">
        <label className="sr-only" htmlFor="journal-search">
          {t('common.search')}
        </label>
        <input
          id="journal-search"
          className="input"
          type="search"
          value={query}
          placeholder={t('journal.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          data-ui={UI.journal.search}
        />
      </div>
      <div className="toolbar">
        <label className="sr-only" htmlFor="journal-from">
          {t('journal.from')}
        </label>
        <input
          id="journal-from"
          className="input"
          type="date"
          value={from}
          aria-label={t('journal.from')}
          onChange={(e) => setFrom(e.target.value)}
        />
        <label className="sr-only" htmlFor="journal-to">
          {t('journal.to')}
        </label>
        <input
          id="journal-to"
          className="input"
          type="date"
          value={to}
          aria-label={t('journal.to')}
          onChange={(e) => setTo(e.target.value)}
        />
        {hasFilter ? (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setQuery('');
              setFrom('');
              setTo('');
            }}
          >
            {t('journal.clearFilter')}
          </button>
        ) : null}
      </div>

      <p className="muted" style={{ fontSize: 13, margin: 'var(--space-2) 0' }}>
        {t('journal.count', { count: filtered.length })}
      </p>

      {filtered.length === 0 ? (
        <div className="card card--pad empty">{t('journal.empty')}</div>
      ) : (
        <ul className="card list" data-ui={UI.journal.list}>
          {filtered.map((entry) => (
            <li key={entry.id} className="list__item">
              <button
                type="button"
                className="list__main"
                onClick={() => onEditEntry(entry)}
                style={{ background: 'transparent', border: 'none', textAlign: 'left' }}
                aria-label={`${t('common.edit')}: ${entry.description}`}
              >
                <div className="list__title">
                  {entry.kind === 'opening' ? (
                    <span className="tag tag--neutral">{t('journal.opening')}</span>
                  ) : null}{' '}
                  {entry.description}
                </div>
                <div className="list__sub">
                  {entry.date}・{flowText(map, entry)}
                </div>
              </button>
              <span className="list__amount">
                <Money
                  amount={entry.lines.find((l) => l.side === 'debit')?.amount ?? 0}
                  currency={currency}
                />
              </span>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setPendingDelete(entry)}
                aria-label={`${t('common.delete')}: ${entry.description}`}
                data-ui={UI.journal.entry.delete}
              >
                <Icon name="trash" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {pendingDelete ? (
        <ConfirmDialog
          title={t('journal.deleteConfirmTitle')}
          body={t('journal.deleteConfirmBody', { description: pendingDelete.description })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            const target = pendingDelete;
            setPendingDelete(null);
            await removeEntry(target.id, target.description).catch(() => undefined);
          }}
        />
      ) : null}
    </section>
  );
}
