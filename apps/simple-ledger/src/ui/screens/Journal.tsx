/*
 * 仕訳一覧。保存される仕訳と計算で生まれる仕訳（継続コスト資産の費用行・定期ルール・
 * 投資利回りの投影）を**区別せず全部**日付順で出す（displayEntriesForAsOf が単一の正本。
 * export には混ぜない）。
 * 並び替え（日付/金額 × 昇/降・既定 = 日付降順）は表示専用。抽出結果には件数と合計を出し、
 * 合計の対象 = 表示している行の集合（科目タップ抽出 = 方向つき和 / それ以外 = 単純和）。
 * 展開範囲 = いま表示している範囲（to → 今日 or 保存仕訳の最も遠い日付。上限 2100-12-31）。
 * 行タップ: 通常 = 編集 / 初期残高・補正 = 専用シート / 購入の仕訳 = 編集（借方は台帳固定）/
 * 計算で生まれた行 = 起票元（項目・ルール・投資科目。derivedEntryOrigin が単一正本）へ遷移。
 */
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { SearchInput, SortControls } from '../ListSearchSort';
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
import { derivedEntryOrigin } from '../../domain/derivedOrigin';
import { displayEntriesForAsOf } from '../../domain/reportEntries';
import { periodRange, type ReportPeriod } from '../../domain/reportPeriod';
import {
  entryAmount,
  isDebitNormal,
  summarizeEntries,
  summarizeEntriesForAccount,
} from '../../domain/accounting';
import {
  isContinuousCostMonthlyAllocationEntry,
  isNormalExpenseEntry,
} from '../../domain/livingCost';
import { tagNames } from '../tagOptions';
import type { AllocationsTarget } from './Allocations';
import type { Account, JournalEntry } from '../../domain/types';
import { formatMoney } from '../../util/format';

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

type AccountBalanceChange = 'increase' | 'decrease' | null;

/**
 * 科目の自然な残高符号で、この仕訳が対象科目を増やすか減らすかを返す。
 * 複合仕訳で同じ科目が両側にある場合も、借貸の純額で判定する。
 */
function accountBalanceChange(entry: JournalEntry, account: Account): AccountBalanceChange {
  const increaseSide = isDebitNormal(account.type) ? 'debit' : 'credit';
  const delta = entry.lines.reduce((sum, line) => {
    if (line.accountId !== account.id) return sum;
    return sum + (line.side === increaseSide ? line.amount : -line.amount);
  }, 0);
  return delta > 0 ? 'increase' : delta < 0 ? 'decrease' : null;
}

export function Journal({
  onEditEntry,
  onReverse,
  onOpenAllocations,
  onOpenAccount,
  filter,
  period,
  targetEntryId,
  onClearFilter,
}: {
  onEditEntry: (entry: JournalEntry) => void;
  onReverse: (entry: JournalEntry) => void;
  /** 計算で生まれた行のタップ: 「毎月のもの」へ遷移し、元の項目/ルールのシートを開く。 */
  onOpenAllocations: (target: AllocationsTarget) => void;
  /** 投資利回りの投影行のタップ: 勘定科目へ遷移し、その投資科目の編集シートを開く。 */
  onOpenAccount: (accountId: string) => void;
  filter: JournalFilter | null;
  period: ReportPeriod;
  /** タイムラインなど外部画面から開く保存仕訳。種類ごとの既存編集シートへ解決する。 */
  targetEntryId?: string | null;
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
  // 表示専用の並び替え（既定 = 日付降順・従来の並びそのもの）。データ・保存には影響しない。
  const [sortKey, setSortKey] = useState<'date' | 'amount'>('date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [pendingDelete, setPendingDelete] = useState<JournalEntry | null>(null);
  const initialTarget = targetEntryId
    ? (ledger?.journalEntries.find((entry) => entry.id === targetEntryId) ?? null)
    : null;
  const [editingOpening, setEditingOpening] = useState<JournalEntry | null>(() =>
    initialTarget?.kind === 'opening' ? initialTarget : null,
  );
  const [pendingOpeningDelete, setPendingOpeningDelete] = useState<JournalEntry | null>(null);
  const [editingAdjustment, setEditingAdjustment] = useState<JournalEntry | null>(() =>
    initialTarget?.metadata?.adjustment ? initialTarget : null,
  );
  const [pendingAdjustmentDelete, setPendingAdjustmentDelete] = useState<JournalEntry | null>(null);

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
    return displayEntriesForAsOf(ledger, expandTo, today).sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, [ledger, expandTo, today]);

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
        const accountNames = e.lines.map((l) => map.get(l.accountId)?.name ?? '').join(' ');
        const hay = `${e.description} ${e.memo ?? ''} ${accountNames}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [source, query, from, to, accountFilterId, normalExpenseOnly, tagFilter, map]);

  // 表示専用の並び替え（C-4）。filtered は基準順（日付降順・同日は登録の新しい順・同時刻は
  // id 昇順）なので、安定ソートにより同値（同日・同額）の並びは必ず基準順を保つ。
  const sorted = useMemo(() => {
    if (sortKey === 'date' && sortDirection === 'desc') return filtered; // 既定 = 基準順そのもの
    const direction = sortDirection === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === 'date') {
        return a.date < b.date ? -direction : a.date > b.date ? direction : 0;
      }
      return (entryAmount(a) - entryAmount(b)) * direction;
    });
  }, [filtered, sortKey, sortDirection]);

  // 抽出結果の件数と合計（C-3）。対象 = いま表示している行の集合そのもの（sorted は filtered の
  // 並び替えなので集合は同じ）＝ユーザーが数えたら必ず合う。科目タップ抽出中はその科目視点の
  // 方向つき和（増減の純額）、それ以外は単純和（仕訳ごとに金額 1 回・二重計上なし）。
  const summary = useMemo(
    () =>
      filterAccount
        ? summarizeEntriesForAccount(filterAccount, filtered, () => true)
        : summarizeEntries(filtered, () => true),
    [filterAccount, filtered],
  );

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
        <SearchInput
          id="journal-search"
          label={t('common.search')}
          value={query}
          onChange={setQuery}
          placeholder={t('journal.searchPlaceholder')}
          dataUi={UI.journal.search}
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

      <SortControls
        ariaLabel={t('common.sort')}
        extraClassName="journal__sort"
        axisItems={[
          { key: 'date', label: t('journal.sortDate'), dataUi: UI.journal.sortByDate },
          { key: 'amount', label: t('journal.sortAmount'), dataUi: UI.journal.sortByAmount },
        ]}
        axisValue={sortKey}
        onAxisChange={(key) => setSortKey(key === 'amount' ? 'amount' : 'date')}
        directionItems={[
          { key: 'desc', label: t('common.sortDesc'), dataUi: UI.journal.sortDesc },
          { key: 'asc', label: t('common.sortAsc'), dataUi: UI.journal.sortAsc },
        ]}
        directionValue={sortDirection}
        onDirectionChange={(key) => setSortDirection(key === 'asc' ? 'asc' : 'desc')}
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          margin: 'var(--space-2) 0',
        }}
      >
        <span className="muted" style={{ fontSize: 13 }} data-ui={UI.journal.summary}>
          {t('journal.count', { count: summary.count })}・{t('journal.total')}{' '}
          <Money amount={summary.total} currency={currency} signed={filterAccount !== undefined} />
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
          {sorted.map((entry) => {
            const md = entry.metadata;
            const isVirtual = md?.virtual === true;
            const isRecovery = md?.monthlyCostRecovery === true;
            // 購入の仕訳（継続コスト資産と 1:1）: 編集シートを開ける（借方は台帳固定・削除不可）。
            const isPurchase = !isVirtual && md?.monthlyCostId !== undefined && !isRecovery;
            const isMonthlyCost =
              md?.monthlyCostId !== undefined ||
              md?.continuousCostId !== undefined ||
              isContinuousCostMonthlyAllocationEntry(entry);
            const isAdjustment = !!md?.adjustment;
            const displayedAmount = entry.lines.find((line) => line.side === 'debit')?.amount ?? 0;
            // 科目ドリル中だけ、その科目の自然な残高符号で増減を示す。金額自体には符号を付けない。
            const balanceChange = filterAccount ? accountBalanceChange(entry, filterAccount) : null;
            const balanceChangeClass =
              balanceChange === 'increase'
                ? 'amount--pos'
                : balanceChange === 'decrease'
                  ? 'amount--neg'
                  : '';
            const balanceChangeLabel =
              balanceChange === 'increase'
                ? t('journal.accountBalanceIncrease', {
                    name: filterAccount?.name ?? '',
                    amount: formatMoney(displayedAmount, currency),
                  })
                : balanceChange === 'decrease'
                  ? t('journal.accountBalanceDecrease', {
                      name: filterAccount?.name ?? '',
                      amount: formatMoney(displayedAmount, currency),
                    })
                  : undefined;
            // 持ち込みの購入の仕訳は kind='opening' だが、専用シートではなく購入の仕訳として編集する。
            const isOpening = entry.kind === 'opening' && !isPurchase;
            // タップ: 計算で生まれた行は起票元（derivedEntryOrigin が単一正本）へ —
            // ルール投影 = そのルール / 月割り = その項目 / 投資利回りの投影 = その投資科目。
            // 由来を名乗らない導出行はタップ不可（既定の遷移先へ流さない＝誤遷移させない）。
            // opening / adjustment は専用シート。それ以外（購入・回収の振替を含む）は編集シート。
            const origin = derivedEntryOrigin(entry);
            const onRowTap = isVirtual
              ? origin === undefined
                ? undefined
                : origin.kind === 'recurringRule'
                  ? () => onOpenAllocations({ ruleId: origin.recurringRuleId })
                  : origin.kind === 'monthlyCost'
                    ? () => onOpenAllocations({ itemId: origin.monthlyCostId })
                    : () => onOpenAccount(origin.accountId)
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
                {onRowTap === undefined ? (
                  // 開く先の無い導出行: ボタンにしない（押せるのに何も起きない/誤遷移する UI を作らない）。
                  <div className="list__main" style={{ textAlign: 'left' }}>
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
                <span
                  className={`list__amount ${balanceChangeClass}`.trim()}
                  aria-label={balanceChangeLabel}
                >
                  <Money amount={displayedAmount} currency={currency} />
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
        <AdjustmentEditSheet entry={editingAdjustment} onClose={() => setEditingAdjustment(null)} />
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
