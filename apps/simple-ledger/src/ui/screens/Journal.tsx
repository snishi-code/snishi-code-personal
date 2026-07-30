/*
 * 仕訳一覧。保存される仕訳と計算で生まれる仕訳（継続コスト資産の費用行・定期ルールの投影）を
 * **区別せず全部**日付順で出す（reportEntriesForAsOf が単一の正本。export には混ぜない）。
 * 展開範囲 = いま表示している範囲（to → 今日 or 保存仕訳の最も遠い日付。上限 2100-12-31）。
 * 行タップ: 通常 = 編集 / 初期残高・補正 = 専用シート / 購入の仕訳 = 編集（借方は台帳固定）/
 * 計算で生まれた行 = 「毎月のもの」の元の項目・ルールのシートへ遷移。
 */
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog } from '../overlays';
import { useLedger } from '../../state/store';
import { AdjustmentEditSheet } from '../AdjustmentSheet';
import { OpeningEditSheet } from '../OpeningSheet';
import { Money } from '../money';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import { todayLocal } from '../../util/time';
import { entryHasTag } from '../../domain/tags';
import { CONTINUOUS_COST_HARD_CAP } from '../../domain/continuousCost';
import { reportEntriesForAsOf } from '../../domain/reportEntries';
import { periodRange, type ReportPeriod } from '../../domain/reportPeriod';
import { isNormalExpenseEntry } from '../../domain/livingCost';
import { tagNames } from '../tagOptions';
import type { AllocationsTarget } from './Allocations';
import type { Account, JournalEntry } from '../../domain/types';

export interface JournalFilter {
  accountId?: string;
  expenseKind?: 'normal';
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
  onOpenAllocations,
  filter,
  period,
  onClearFilter,
}: {
  onEditEntry: (entry: JournalEntry) => void;
  onReverse: (entry: JournalEntry) => void;
  /** 計算で生まれた行のタップ: 「毎月のもの」へ遷移し、元の項目/ルールのシートを開く。 */
  onOpenAllocations: (target: AllocationsTarget) => void;
  filter: JournalFilter | null;
  period: ReportPeriod;
  onClearFilter: () => void;
}) {
  const { ledger, removeEntry, deleteOpening, deleteAdjustment } = useLedger();
  const [query, setQuery] = useState('');
  // 明示フィルターで開いた場合はその範囲を優先し、メニューから直接開いた場合は
  // 初回描画から共有期間を反映する。period effect は明示フィルターを上書きしないよう初回を飛ばす。
  const [from, setFrom] = useState(() =>
    filter ? (filter.from ?? '') : (periodRange(period)?.from ?? ''),
  );
  const [to, setTo] = useState(() =>
    filter ? (filter.to ?? '') : (periodRange(period)?.to ?? ''),
  );
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
  const normalExpenseOnly = filter?.expenseKind === 'normal';
  const map = useMemo(() => new Map((ledger?.accounts ?? []).map((a) => [a.id, a])), [ledger]);
  const currency = ledger?.settings.currency ?? 'JPY';
  const filterAccount = accountFilterId ? map.get(accountFilterId) : undefined;

  const allTags = ledger?.tags ?? [];

  // どこまで展開するか = いま表示している範囲そのもの。
  //  - to があればそこまで / 無ければ今日まで / 「将来予定も表示」は保存仕訳の最も遠い日付まで
  //    （返済の未来仕訳がそこまである。データで決まるので上限が青天井にならない）。
  //  - いずれもエンジンの上限（2100-12-31）でクランプ。
  const today = todayLocal();
  const expandTo = useMemo(() => {
    // loadLedger は日付降順で返すので先頭が最も遠い日付。
    const farthest = ledger?.journalEntries[0]?.date ?? today;
    const base = to !== '' ? to : showFuture ? (farthest > today ? farthest : today) : today;
    return base < CONTINUOUS_COST_HARD_CAP ? base : CONTINUOUS_COST_HARD_CAP;
  }, [ledger, to, showFuture, today]);

  // 保存される仕訳 + 計算で生まれる仕訳（分けない）。混合後に必ずソートし直す。
  const source = useMemo(() => {
    if (!ledger) return [];
    return reportEntriesForAsOf(ledger, expandTo).sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, [ledger, expandTo]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return source.filter((e) => {
      if (accountFilterId && !e.lines.some((l) => l.accountId === accountFilterId)) return false;
      if (normalExpenseOnly && !isNormalExpenseEntry(e, map)) return false;
      if (tagFilter && !entryHasTag(e, tagFilter)) return false;
      if (from && e.date < from) return false;
      if (to && e.date > to) return false;
      if (q) {
        // 検索対象 = 摘要・メモ + 借方/貸方の勘定科目名（「食費」で検索 → 食費が絡む仕訳が出る）。
        const accountNames = e.lines
          .map((l) => map.get(l.accountId)?.name ?? '')
          .join(' ');
        const hay = `${e.description} ${e.memo ?? ''} ${accountNames}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [source, query, from, to, accountFilterId, normalExpenseOnly, tagFilter, map]);

  const hasDateOrQuery = query !== '' || from !== '' || to !== '';

  return (
    <section aria-labelledby="journal-title" data-ui={UI.journal.view}>
      <h1 className="screen-title" id="journal-title">
        {t('journal.title')}
      </h1>

      {filterAccount || normalExpenseOnly ? (
        <div className="toolbar">
          {filterAccount ? (
            <span className="filter-chip">
              {t('journal.filteredByAccount', { name: filterAccount.name })}
              <button
                type="button"
                onClick={onClearFilter}
                aria-label={t('journal.clearAccountFilter')}
                data-ui={UI.journal.clearAccountFilter}
              >
                <Icon name="close" size={16} />
              </button>
            </span>
          ) : null}
          {normalExpenseOnly ? (
            <span className="filter-chip">
              {t('journal.filteredByNormalExpense')}
              <button
                type="button"
                onClick={onClearFilter}
                aria-label={t('journal.clearNormalExpenseFilter')}
                data-ui={UI.journal.clearNormalExpenseFilter}
              >
                <Icon name="close" size={16} />
              </button>
            </span>
          ) : null}
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
          max={CONTINUOUS_COST_HARD_CAP}
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
          max={CONTINUOUS_COST_HARD_CAP}
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
            const md = entry.metadata;
            const isVirtual = md?.virtual === true;
            const isRecovery = md?.monthlyCostRecovery === true;
            // 購入の仕訳（継続コスト資産と 1:1）: 編集シートを開ける（借方は台帳固定・削除不可）。
            const isPurchase = !isVirtual && md?.monthlyCostId !== undefined && !isRecovery;
            const isMonthlyCost = md?.monthlyCostId !== undefined || md?.continuousCostId !== undefined;
            const isAdjustment = !!md?.adjustment;
            // 持ち込みの購入の仕訳は kind='opening' だが、専用シートではなく購入の仕訳として編集する。
            const isOpening = entry.kind === 'opening' && !isPurchase;
            // タップ: 計算で生まれた行は「毎月のもの」の元のルール/項目へ。opening / adjustment は
            // 専用シート。それ以外（購入の仕訳・回収の振替を含む）は編集シート。
            const onRowTap = isVirtual
              ? () =>
                  onOpenAllocations(
                    md?.recurringRuleId !== undefined
                      ? { ruleId: md.recurringRuleId }
                      : { itemId: md?.continuousCostId ?? '' },
                  )
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
                <button
                  type="button"
                  className="list__main"
                  onClick={onRowTap}
                  style={{ background: 'transparent', border: 'none', textAlign: 'left' }}
                  aria-label={`${t('common.edit')}: ${entry.description}`}
                >
                  {title}
                </button>
                <span className="list__amount">
                  <Money
                    amount={entry.lines.find((l) => l.side === 'debit')?.amount ?? 0}
                    currency={currency}
                  />
                </span>
                {isVirtual || isPurchase ? null : isAdjustment ? (
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
                    {/* 回収の振替の逆仕訳は台帳の不変条件（⑧）で保存できないため出さない。 */}
                    {isRecovery ? null : (
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => onReverse(entry)}
                        aria-label={`${t('journal.reverseAction')}: ${entry.description}`}
                        data-ui={UI.journal.entry.reverse}
                      >
                        <Icon name="reverse" size={18} />
                      </button>
                    )}
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
