/*
 * 仕訳一覧。検索（摘要・メモ）・期間絞り込み・勘定科目絞り込み（PL/BS からの遷移）。
 * 行タップで編集、各行に取消/返金（逆仕訳）と削除。削除は明示確認。
 */
import { useEffect, useMemo, useState } from 'react';
import { useLedger } from '../../state/store';
import { Money } from '../money';
import { Icon } from '../Icon';
import { ConfirmDialog } from '../ConfirmDialog';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import { todayLocal } from '../../util/time';
import { entryHasTag } from '../../domain/tags';
import { tagNames } from '../tagOptions';
import type { Account, JournalEntry } from '../../domain/types';

export interface JournalFilter {
  accountId?: string;
  from?: string;
  to?: string;
}

function flowText(map: Map<string, Account>, entry: JournalEntry): string {
  const debit = entry.lines.find((l) => l.side === 'debit');
  const credit = entry.lines.find((l) => l.side === 'credit');
  const name = (id?: string) => (id ? (map.get(id)?.name ?? '—') : '—');
  return `${name(debit?.accountId)} → ${name(credit?.accountId)}`;
}

export function Journal({
  onEditEntry,
  onReverse,
  filter,
  onClearAccountFilter,
}: {
  onEditEntry: (entry: JournalEntry) => void;
  onReverse: (entry: JournalEntry) => void;
  filter: JournalFilter | null;
  onClearAccountFilter: () => void;
}) {
  const { ledger, removeEntry } = useLedger();
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState(filter?.from ?? '');
  const [to, setTo] = useState(filter?.to ?? '');
  // 既定では未来の按分認識仕訳を隠す（今日まで）。トグルで将来予定も表示。
  const [showFuture, setShowFuture] = useState(false);
  const [tagFilter, setTagFilter] = useState('');
  const [pendingDelete, setPendingDelete] = useState<JournalEntry | null>(null);

  // PL からのドリルダウンで期間が渡されたら、日付絞り込みに反映する。
  useEffect(() => {
    if (!filter) return;
    if (filter.from !== undefined) setFrom(filter.from);
    if (filter.to !== undefined) setTo(filter.to);
  }, [filter]);

  const accountFilterId = filter?.accountId;
  const map = useMemo(() => new Map((ledger?.accounts ?? []).map((a) => [a.id, a])), [ledger]);
  const currency = ledger?.settings.currency ?? 'JPY';
  const filterAccount = accountFilterId ? map.get(accountFilterId) : undefined;

  // 上限日: 明示 to があれば優先。無ければ既定は今日まで（showFuture で解除）。
  const effectiveTo = to !== '' ? to : showFuture ? '' : todayLocal();

  const allTags = ledger?.tags ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (ledger?.journalEntries ?? []).filter((e) => {
      if (accountFilterId && !e.lines.some((l) => l.accountId === accountFilterId)) return false;
      if (tagFilter && !entryHasTag(e, tagFilter)) return false;
      if (from && e.date < from) return false;
      if (effectiveTo && e.date > effectiveTo) return false;
      if (q) {
        const hay = `${e.description} ${e.memo ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [ledger, query, from, effectiveTo, accountFilterId, tagFilter]);

  const hasDateOrQuery = query !== '' || from !== '' || to !== '';

  return (
    <section aria-labelledby="journal-title" data-ui={UI.journal.view}>
      <h1 className="screen-title" id="journal-title">
        {t('journal.title')}
      </h1>

      {filterAccount ? (
        <div className="toolbar">
          <span className="filter-chip">
            {t('journal.filteredByAccount', { name: filterAccount.name })}
            <button
              type="button"
              onClick={onClearAccountFilter}
              aria-label={t('journal.clearAccountFilter')}
              data-ui={UI.journal.clearAccountFilter}
            >
              <Icon name="close" size={16} />
            </button>
          </span>
        </div>
      ) : null}

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
        {allTags.length > 0 ? (
          <>
            <label className="sr-only" htmlFor="journal-tag">
              {t('journal.filterTag')}
            </label>
            <select
              id="journal-tag"
              className="select"
              value={tagFilter}
              aria-label={t('journal.filterTag')}
              onChange={(e) => setTagFilter(e.target.value)}
              data-ui={UI.journal.filterTag}
            >
              <option value="">{t('journal.allTags')}</option>
              {allTags
                .filter((tg) => !tg.archived || tg.id === tagFilter)
                .map((tg) => (
                  <option key={tg.id} value={tg.id}>
                    {tg.name}
                  </option>
                ))}
            </select>
          </>
        ) : null}
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
        {hasDateOrQuery ? (
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

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          margin: 'var(--space-2) 0',
        }}
      >
        <span className="muted" style={{ fontSize: 13 }}>
          {t('journal.count', { count: filtered.length })}
        </span>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={showFuture}
            onChange={(e) => setShowFuture(e.target.checked)}
            data-ui={UI.journal.showFuture}
          />
          {t('journal.showFuture')}
        </label>
      </div>

      {filtered.length === 0 ? (
        <div className="card card--pad empty">{t('journal.empty')}</div>
      ) : (
        <ul className="card list" data-ui={UI.journal.list}>
          {filtered.map((entry) => {
            const generated = !!entry.metadata?.allocationId;
            const entryTagNames = tagNames(allTags, entry.tagIds);
            const lineTagNames = tagNames(
              allTags,
              entry.lines.flatMap((l) => l.tagIds ?? []),
            );
            const title = (
              <>
                <div className="list__title">
                  {entry.kind === 'opening' ? (
                    <span className="tag tag--neutral">{t('journal.opening')}</span>
                  ) : null}
                  {entry.metadata?.inputMode === 'reversal' ? (
                    <span className="tag tag--warning">{t('journal.reversalTag')}</span>
                  ) : null}
                  {generated ? (
                    <span className="tag tag--teal">{t('journal.allocationTag')}</span>
                  ) : null}{' '}
                  {entry.description}
                </div>
                <div className="list__sub">
                  {entry.date}・{flowText(map, entry)}
                </div>
                {entryTagNames.length > 0 || lineTagNames.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {entryTagNames.map((n) => (
                      <span key={`e-${n}`} className="tag tag--teal">
                        {n}
                      </span>
                    ))}
                    {lineTagNames.map((n) => (
                      <span key={`l-${n}`} className="tag tag--neutral">
                        {n}
                      </span>
                    ))}
                  </div>
                ) : null}
              </>
            );
            return (
              <li key={entry.id} className="list__item">
                {generated ? (
                  // 按分生成仕訳は読み取り専用（編集/取消/削除はしない。按分台帳で管理）。
                  <div className="list__main" title={t('journal.generatedNotice')}>
                    {title}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="list__main"
                    onClick={() => onEditEntry(entry)}
                    style={{ background: 'transparent', border: 'none', textAlign: 'left' }}
                    aria-label={`${t('common.edit')}: ${entry.description}`}
                  >
                    {title}
                  </button>
                )}
                <span className="list__amount">
                  <Money
                    amount={entry.lines.find((l) => l.side === 'debit')?.amount ?? 0}
                    currency={currency}
                  />
                </span>
                {generated ? null : (
                  <>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => onReverse(entry)}
                      aria-label={`${t('journal.reverseAction')}: ${entry.description}`}
                      data-ui={UI.journal.entry.reverse}
                    >
                      <Icon name="reverse" size={18} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setPendingDelete(entry)}
                      aria-label={`${t('common.delete')}: ${entry.description}`}
                      data-ui={UI.journal.entry.delete}
                    >
                      <Icon name="trash" size={18} />
                    </button>
                  </>
                )}
              </li>
            );
          })}
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
