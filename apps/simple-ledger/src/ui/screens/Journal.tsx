/*
 * 仕訳一覧。検索（摘要・メモ）・期間絞り込み・勘定科目絞り込み（PL/BS からの遷移）。
 * 行タップで編集、各行に取消/返金（逆仕訳）と削除。削除は明示確認。
 * 初期残高(opening)・残高補正(adjustment)の履歴はこの画面に寄せ、行から専用の
 * 編集・削除シートを開く（通常仕訳の編集・削除で壊さない。会計意味を混ぜない）。
 */
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { useLedger } from '../../state/store';
import { AdjustmentEditSheet } from '../AdjustmentSheet';
import { OpeningEditSheet } from '../OpeningSheet';
import { Money } from '../money';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import { currentYearMonth, todayLocal } from '../../util/time';
import { entryHasTag } from '../../domain/tags';
import { monthlyCostForMonth } from '../../domain/monthlyCost';
import { periodRange, type ReportPeriod } from '../../domain/reportPeriod';
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
  return `${name(credit?.accountId)} → ${name(debit?.accountId)}`;
}

export function Journal({
  onEditEntry,
  onReverse,
  filter,
  period,
  onClearAccountFilter,
}: {
  onEditEntry: (entry: JournalEntry) => void;
  onReverse: (entry: JournalEntry) => void;
  filter: JournalFilter | null;
  period: ReportPeriod;
  onClearAccountFilter: () => void;
}) {
  const { ledger, removeEntry, deleteOpening, deleteAdjustment } = useLedger();
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState(filter?.from ?? '');
  const [to, setTo] = useState(filter?.to ?? '');
  const [showFuture, setShowFuture] = useState(false);
  const [tagFilter, setTagFilter] = useState('');
  const [pendingDelete, setPendingDelete] = useState<JournalEntry | null>(null);
  const [editingOpening, setEditingOpening] = useState<JournalEntry | null>(null);
  const [pendingOpeningDelete, setPendingOpeningDelete] = useState<JournalEntry | null>(null);
  const [editingAdjustment, setEditingAdjustment] = useState<JournalEntry | null>(null);
  const [pendingAdjustmentDelete, setPendingAdjustmentDelete] = useState<JournalEntry | null>(
    null,
  );

  useEffect(() => {
    if (!filter) return;
    startTransition(() => {
      if (filter.from !== undefined) setFrom(filter.from);
      if (filter.to !== undefined) setTo(filter.to);
    });
  }, [filter]);

  const periodMounted = useRef(false);
  useEffect(() => {
    if (!periodMounted.current) {
      periodMounted.current = true;
      return;
    }
    const r = periodRange(period);
    setFrom(r?.from ?? '');
    setTo(r?.to ?? '');
  }, [period]);

  const accountFilterId = filter?.accountId;
  const map = useMemo(() => new Map((ledger?.accounts ?? []).map((a) => [a.id, a])), [ledger]);
  const currency = ledger?.settings.currency ?? 'JPY';
  const filterAccount = accountFilterId ? map.get(accountFilterId) : undefined;

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

  const { year, month } = currentYearMonth();
  const currentYm = `${year}-${String(month).padStart(2, '0')}`;
  const { recognitionYm, monthRecognitions } = useMemo(() => {
    let ym: string | null = null;
    if (from === '' && to === '') ym = currentYm;
    else if (from !== '' && to !== '' && from.slice(0, 7) === to.slice(0, 7)) ym = from.slice(0, 7);
    if (tagFilter) ym = null;
    if (!ym) return { recognitionYm: null, monthRecognitions: [] };
    const accById = new Map((ledger?.accounts ?? []).map((a) => [a.id, a]));
    const rows = (ledger?.monthlyCostItems ?? [])
      .filter((m) => !accountFilterId || m.expenseAccountId === accountFilterId)
      .map((m) => {
        const recCredit = m.recognitionCreditAccountId
          ? accById.get(m.recognitionCreditAccountId)?.name
          : undefined;
        const expName = accById.get(m.expenseAccountId)?.name;
        const label = recCredit
          ? `${recCredit} → ${expName ?? '—'}`
          : t('journal.monthlyCostRow', { name: m.name });
        return { id: m.id, label, amount: monthlyCostForMonth(m, ym!) };
      })
      .filter((r) => r.amount > 0);
    return { recognitionYm: ym, monthRecognitions: rows };
  }, [ledger, accountFilterId, tagFilter, from, to, currentYm]);
  const recognitionMonthLabel = recognitionYm ?? currentYm;
  const monthRecognitionTotal = monthRecognitions.reduce((s, r) => s + r.amount, 0);

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

      {monthRecognitions.length > 0 ? (
        <div className="card" data-ui={UI.journal.monthlyRecognition}>
          <div className="stmt-row stmt-row--total">
            <span>
              {t('journal.monthlyRecognitionTitle', {
                year: Number(recognitionMonthLabel.slice(0, 4)),
                month: Number(recognitionMonthLabel.slice(5, 7)),
              })}
            </span>
            <span className="stmt-row__num">
              <Money amount={monthRecognitionTotal} currency={currency} />
            </span>
          </div>
          {monthRecognitions.map((r) => (
            <div className="stmt-row" key={r.id} data-ui={UI.journal.monthlyRecognitionRow}>
              <span>
                {r.label} <span className="tag tag--teal">{t('journal.monthlyCostTag')}</span>
              </span>
              <span className="stmt-row__num">
                <Money amount={r.amount} currency={currency} />
              </span>
            </div>
          ))}
          <div className="stmt-row muted" style={{ fontSize: 12 }}>
            {t('journal.monthlyRecognitionNote')}
          </div>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="card card--pad empty">{t('journal.empty')}</div>
      ) : (
        <ul className="card list" data-ui={UI.journal.list}>
          {filtered.map((entry) => {
            const isAllocation = !!entry.metadata?.allocationId;
            const isMonthlyCost = !!entry.metadata?.monthlyCostId;
            const isDisposal = !!entry.metadata?.assetDisposalId;
            const isAdjustment = !!entry.metadata?.adjustment;
            const isOpening = entry.kind === 'opening';
            const generated = isAllocation || isMonthlyCost || isDisposal;
            // opening / adjustment は通常編集ではなく専用シートを開く（会計意味を保つ）。
            const onRowTap = generated
              ? undefined
              : isAdjustment
                ? () => setEditingAdjustment(entry)
                : isOpening
                  ? () => setEditingOpening(entry)
                  : () => onEditEntry(entry);
            const entryTagNames = tagNames(allTags, entry.tagIds);
            const title = (
              <>
                <div className="list__title">
                  {entry.kind === 'opening' ? (
                    <span className="tag tag--neutral">{t('journal.opening')}</span>
                  ) : null}
                  {entry.metadata?.inputMode === 'reversal' ? (
                    <span className="tag tag--warning">{t('journal.reversalTag')}</span>
                  ) : null}
                  {isAllocation ? (
                    <span className="tag tag--teal">{t('journal.allocationTag')}</span>
                  ) : null}
                  {isMonthlyCost ? (
                    <span className="tag tag--teal">{t('journal.monthlyCostTag')}</span>
                  ) : null}
                  {entry.metadata?.adjustment ? (
                    <span className="tag tag--neutral">{t('journal.adjustmentTag')}</span>
                  ) : null}{' '}
                  {entry.description}
                </div>
                <div className="list__sub">
                  {entry.date}・{flowText(map, entry)}
                </div>
                {entryTagNames.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {entryTagNames.map((n) => (
                      <span key={`e-${n}`} className="tag tag--teal">
                        {n}
                      </span>
                    ))}
                  </div>
                ) : null}
              </>
            );
            return (
              <li key={entry.id} className="list__item">
                {onRowTap === undefined ? (
                  <div className="list__main" title={t('journal.generatedNotice')}>
                    {title}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="list__main"
                    onClick={onRowTap}
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
                {generated ? null : isAdjustment ? (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setPendingAdjustmentDelete(entry)}
                    aria-label={`${t('common.delete')}: ${entry.description}`}
                    data-ui={UI.adjustments.rowDelete}
                  >
                    <Icon name="delete" size={18} />
                  </button>
                ) : isOpening ? (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setPendingOpeningDelete(entry)}
                    aria-label={`${t('common.delete')}: ${entry.description}`}
                    data-ui={UI.adjustments.openingRowDelete}
                  >
                    <Icon name="delete" size={18} />
                  </button>
                ) : (
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
                      <Icon name="delete" size={18} />
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

      {editingOpening ? (
        <OpeningEditSheet entry={editingOpening} onClose={() => setEditingOpening(null)} />
      ) : null}
      {pendingOpeningDelete ? (
        <ConfirmDialog
          title={t('opening.deleteConfirmTitle')}
          body={t('opening.deleteConfirmBody')}
          confirmLabel={t('common.delete')}
          danger
          dataUi={UI.adjustments.openingDeleteConfirm}
          onCancel={() => setPendingOpeningDelete(null)}
          onConfirm={async () => {
            const target = pendingOpeningDelete;
            setPendingOpeningDelete(null);
            await deleteOpening(target.id).catch(() => undefined);
          }}
        />
      ) : null}

      {editingAdjustment ? (
        <AdjustmentEditSheet
          entry={editingAdjustment}
          onClose={() => setEditingAdjustment(null)}
        />
      ) : null}
      {pendingAdjustmentDelete ? (
        <ConfirmDialog
          title={t('adjust.deleteConfirmTitle')}
          body={t('adjust.deleteConfirmBody')}
          confirmLabel={t('common.delete')}
          danger
          dataUi={UI.adjustments.deleteConfirm}
          onCancel={() => setPendingAdjustmentDelete(null)}
          onConfirm={async () => {
            const target = pendingAdjustmentDelete;
            setPendingAdjustmentDelete(null);
            await deleteAdjustment(target.id).catch(() => undefined);
          }}
        />
      ) : null}
    </section>
  );
}
