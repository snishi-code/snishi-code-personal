/*
 * 仕訳一覧。保存される仕訳と計算で生まれる仕訳（継続コスト資産の費用行・定期ルール・
 * 残高補正の按分スライス・投資の利回り導出）を**区別せず全部**日付順で出す
 * （displayEntriesForAsOf が単一の正本。export には混ぜない）。
 * 並び替え（日付/金額 × 昇/降・既定 = 日付降順）は表示専用。抽出結果には件数と合計を出し、
 * 合計の対象 = 表示している行の集合（科目タップ抽出 = 方向つき和 / それ以外 = 単純和）。
 * 展開範囲 = いま表示している範囲（to → 今日 or 保存仕訳の最も遠い日付。上限 2100-12-31）。
 * 行タップ: 通常 = 編集 / 初期残高・補正 = 専用シート / 購入の仕訳 = 編集（借方は台帳固定）/
 * 計算で生まれた行 = 起票元（項目・ルール・投資科目。derivedEntryOrigin が単一正本）へ遷移。
 * くり返し記帳から生まれた実仕訳は読み取り専用（作者決定 2026-08-15）: row-action を出さず、
 * タップは由来ルールへ（未起票の投影とまったく同じ行になる）。
 */
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import {
  LIST_SORT_AXES,
  SearchInput,
  SortControls,
  listSortAxisKey,
  type ListSortAxisKey,
} from '../ListSearchSort';
import { applySort, directionSign, matchesQuery, type SortDirection } from '../listQuery';
import { useLedger } from '../../state/store';
import { AdjustmentEditSheet } from '../AdjustmentSheet';
import { OpeningEditSheet } from '../OpeningSheet';
import { Money } from '../money';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import { todayLocal } from '../../util/time';
import { CONTINUOUS_COST_HARD_CAP } from '../../domain/continuousCost';
import { entryOpenPlan } from '../entryOpen';
import { generatedEntryRuleId } from '../../domain/recurringIds';
import { displayEntriesResultForAsOf } from '../../domain/reportEntries';
import { periodRange, type ReportPeriod } from '../../domain/reportPeriod';
import {
  entryAmount,
  isDebitNormal,
  representativeEntryAmount,
  summarizeEntries,
  summarizeEntriesForAccount,
} from '../../domain/accounting';
import {
  isContinuousCostMonthlyAllocationEntry,
  isNormalExpenseEntry,
} from '../../domain/livingCost';
import type { AllocationsTarget } from './Allocations';
import type { Account, JournalEntry } from '../../domain/types';
import { formatMoney } from '../../util/format';
import { useMoneyDigits } from '../money';
import { ScrollTopButton } from '../ScrollTopButton';
import { InvestmentProjectionTruncationNotice } from '../components/InvestmentProjectionTruncationNotice';
import { assertSafeAmount } from '../../domain/safeSum';

/**
 * 軸ごとの data-ui（軸の集合そのものは LIST_SORT_AXES が正本で、画面ごとに違うのはここだけ）。
 */
const SORT_AXIS_DATA_UI: Record<ListSortAxisKey, string> = {
  date: UI.journal.sortByDate,
  amount: UI.journal.sortByAmount,
  name: UI.journal.sortByName,
};

/**
 * 軸ごとの既定方向（日付 = 新しい順 = 従来の既定 / 金額 = 大きい順 / 名称 = 五十音順）。
 * 軸を切り替えたらここへ戻す（月割り台帳と同じ規約。日付軸の向きだけ意味が違うため
 * 値自体は画面ごとに持つ）。
 */
const SORT_DEFAULT_DIRECTION: Record<ListSortAxisKey, SortDirection> = {
  date: 'desc',
  amount: 'desc',
  name: 'asc',
};

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
    return assertSafeAmount(sum + (line.side === increaseSide ? line.amount : -line.amount));
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
  /** 計算で生まれた行のタップ: 「月割り台帳」へ遷移し、元の項目/ルールのシートを開く。 */
  onOpenAllocations: (target: AllocationsTarget) => void;
  /** 投資利回りの投影行のタップ: 勘定科目へ遷移し、その投資科目の編集シートを開く。 */
  onOpenAccount: (accountId: string) => void;
  filter: JournalFilter | null;
  period: ReportPeriod;
  /** タイムラインなど外部画面から開く保存仕訳。種類ごとの既存編集シートへ解決する。 */
  targetEntryId?: string | null;
  onClearFilter: () => void;
}) {
  const { ledger } = useLedger();
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
  // 表示専用の並び替え（既定 = 日付降順・従来の並びそのもの）。データ・保存には影響しない。
  const [sortKey, setSortKey] = useState<ListSortAxisKey>('date');
  const [sortDirection, setSortDirection] = useState<SortDirection>(SORT_DEFAULT_DIRECTION.date);
  const initialTarget = targetEntryId
    ? (ledger?.journalEntries.find((entry) => entry.id === targetEntryId) ?? null)
    : null;
  const [editingOpening, setEditingOpening] = useState<JournalEntry | null>(() =>
    initialTarget?.kind === 'opening' ? initialTarget : null,
  );
  const [editingAdjustment, setEditingAdjustment] = useState<JournalEntry | null>(() =>
    initialTarget?.metadata?.adjustment ? initialTarget : null,
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
  // 導出行から宣言（stored 仕訳）へ戻る引き当て表。補正の按分スライスが親の pin を開く。
  const storedById = useMemo(
    () => new Map((ledger?.journalEntries ?? []).map((e) => [e.id, e])),
    [ledger],
  );
  const currency = ledger?.settings.currency ?? '';
  const digits = useMoneyDigits();
  const filterAccount = accountFilterId ? map.get(accountFilterId) : undefined;

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
  const sourceDisplay = useMemo(() => {
    if (!ledger) return null;
    const display = displayEntriesResultForAsOf(ledger, expandTo);
    return {
      ...display,
      entries: display.entries.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }),
    };
  }, [ledger, expandTo]);
  const source = useMemo(() => sourceDisplay?.entries ?? [], [sourceDisplay]);

  const filtered = useMemo(() => {
    return source.filter((e) => {
      if (accountFilterId && !e.lines.some((l) => l.accountId === accountFilterId)) return false;
      if (normalExpenseOnly && !isNormalExpenseEntry(e, map)) return false;
      if (from && e.date < from) return false;
      if (to && e.date > to) return false;
      // 検索対象 = 摘要・メモ + 借方/貸方の勘定科目名（「食費」で検索 → 食費が絡む仕訳が出る）。
      // 正規化は listQuery.matchesQuery が唯一の正本（月割り台帳画面と同じ規則）。
      const accountNames = e.lines.map((l) => map.get(l.accountId)?.name ?? '').join(' ');
      return matchesQuery([e.description, e.memo, accountNames], query);
    });
  }, [source, query, from, to, accountFilterId, normalExpenseOnly, map]);

  // 表示専用の並び替え（C-4）。filtered は基準順（日付降順・同日は登録の新しい順・同時刻は
  // id 昇順）なので、安定ソートにより同値（同日・同額・同摘要）の並びは必ず基準順を保つ。
  // 既定（日付降順）は applySort が compare=null を素通しする＝基準順そのもの。
  // 名称軸 = 摘要の五十音順（月割り台帳の項目名と同じ localeCompare(…, 'ja')）。
  const sorted = useMemo(() => {
    const direction = directionSign(sortDirection);
    const compare =
      sortKey === 'date' && sortDirection === 'desc'
        ? null
        : sortKey === 'date'
          ? (a: JournalEntry, b: JournalEntry) =>
              a.date < b.date ? -direction : a.date > b.date ? direction : 0
          : sortKey === 'amount'
            ? (a: JournalEntry, b: JournalEntry) => (entryAmount(a) - entryAmount(b)) * direction
            : (a: JournalEntry, b: JournalEntry) =>
                a.description.localeCompare(b.description, 'ja') * direction;
    return applySort(filtered, compare);
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
    <section className="journal" aria-labelledby="journal-title" data-ui={UI.journal.view}>
      <h1 className="screen-title" id="journal-title">
        {t('journal.title')}
      </h1>

      <InvestmentProjectionTruncationNotice
        truncations={sourceDisplay?.investmentProjectionTruncations ?? []}
        accounts={ledger?.accounts ?? []}
      />

      {/* 絞り込み額縁: 検索・期間・タグ・並び替え・件数を sticky で上端に固定し、
          仕訳カードだけが下を流れる（作者合意 2026-08-15・ホームの額縁と同型）。
          h1 は含めない = スクロールで流れてよい。 */}
      <div className="list-filter-frame" data-ui={UI.journal.filterFrame}>
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
          axisItems={LIST_SORT_AXES.map((axis) => ({
            key: axis.key,
            label: t(axis.labelKey),
            dataUi: SORT_AXIS_DATA_UI[axis.key],
          }))}
          axisValue={sortKey}
          onAxisChange={(key) => {
            const next = listSortAxisKey(key);
            setSortKey(next);
            // 軸を変えたら方向は軸ごとの既定へ戻す（前の軸の方向を持ち越さない）。
            setSortDirection(SORT_DEFAULT_DIRECTION[next]);
          }}
          directionItems={[
            { key: 'desc', label: t('common.sortDesc'), dataUi: UI.journal.sortDesc },
            { key: 'asc', label: t('common.sortAsc'), dataUi: UI.journal.sortAsc },
          ]}
          directionValue={sortDirection}
          onDirectionChange={(key) => setSortDirection(key === 'asc' ? 'asc' : 'desc')}
        />

        {/* 件数・合計と「未来分を表示」も額縁に含める（＝スクロール中も母集合が手元に残る）。
            余白は額縁の gap が持つので margin は置かない。 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
          }}
        >
          <span className="muted" style={{ fontSize: 13 }} data-ui={UI.journal.summary}>
            {t('journal.count', { count: summary.count })}・{t('journal.total')}{' '}
            <Money
              amount={summary.total}
              currency={currency}
              signed={filterAccount !== undefined}
            />
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
            // 補正の stored 仕訳は集計から外れて一覧に出ない。並ぶのは按分スライスなので、
            // タグも操作の抑止もスライス側で名乗る（v13.4 ①）。
            const isAdjustment = !!md?.adjustment || md?.adjustmentSliceOf !== undefined;
            // くり返し記帳から生まれた仕訳は読み取り専用（作者決定 2026-08-15）。
            // 編集・削除・反対仕訳はどれも出さず、タップは由来ルールへ（entryOpenPlan が担う）。
            const isRuleGenerated = generatedEntryRuleId(entry) !== undefined;
            // 仕訳の代表額は domain が正本（式を UI で書き直さない）。render から呼ぶので
            // checked sum を通さない representativeEntryAmount を使う（表示中に投げない）。
            const displayedAmount = representativeEntryAmount(entry);
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
                    amount: formatMoney(displayedAmount, currency, digits),
                  })
                : balanceChange === 'decrease'
                  ? t('journal.accountBalanceDecrease', {
                      name: filterAccount?.name ?? '',
                      amount: formatMoney(displayedAmount, currency, digits),
                    })
                  : undefined;
            // 持ち込みの購入の仕訳は kind='opening' だが、専用シートではなく購入の仕訳として編集する。
            const isOpening = entry.kind === 'opening' && !isPurchase;
            // タップ: 計算で生まれた行は起票元（derivedEntryOrigin が単一正本）へ —
            // ルール投影 = そのルール / 月割り = その項目 / 投資利回りの投影 = その投資科目。
            // 何を開くかは entryOpenPlan（単一正本）が決める。ここは計画の実行だけ。
            const plan = entryOpenPlan(entry);
            // 補正は宣言した stored の pin を開く（並んでいるのは按分スライス）。
            // pin が引けない壊れたデータでは押せなくする（空のシートを開かない）。
            const adjustmentPin =
              plan.kind === 'adjustment' ? (storedById.get(plan.entryId) ?? null) : null;
            const onRowTap =
              plan.kind === 'none'
                ? undefined
                : plan.kind === 'rule'
                  ? () => onOpenAllocations({ ruleId: plan.ruleId })
                  : plan.kind === 'item'
                    ? () => onOpenAllocations({ itemId: plan.itemId })
                    : plan.kind === 'account'
                      ? () => onOpenAccount(plan.accountId)
                      : plan.kind === 'adjustment'
                        ? adjustmentPin
                          ? () => setEditingAdjustment(adjustmentPin)
                          : undefined
                        : plan.kind === 'opening'
                          ? () => setEditingOpening(entry)
                          : () => onEditEntry(entry);
            // バッジは摘要の後ろ（v13.1 その6・実ユーズ指摘）: 行の読み出しは摘要から始まり、
            // バッジ・ボタンは摘要と金額の間に並ぶ（「月割り台帳」の種別タグと同位置）。
            const title = (
              <>
                <div className="list__title">
                  {entry.description}{' '}
                  {entry.kind === 'opening' ? (
                    <span className="tag tag--neutral">{t('journal.opening')}</span>
                  ) : null}
                  {entry.metadata?.inputMode === 'reversal' ? (
                    <span className="tag tag--warning">{t('journal.reversalTag')}</span>
                  ) : null}
                  {isMonthlyCost ? (
                    <span className="tag tag--teal">{t('journal.monthlyCostTag')}</span>
                  ) : null}
                  {isAdjustment ? (
                    <span className="tag tag--neutral">{t('journal.adjustmentTag')}</span>
                  ) : null}
                </div>
                <div className="list__sub">
                  {entry.date}・{flowText(map, entry)}
                </div>
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
                {/* 右列 = 上段 金額 / 下段 操作。月割り台帳・勘定科目と同じ行の設計図
                    （v13.3: 金額の桁数でボタンの位置がずれない = 両方が縦に揃う）。
                    行アクションは「現実の変化を記す」動詞（反対仕訳）だけ。削除は各編集シートの
                    最下部（動詞体系 v13.1）。回収の振替の逆仕訳は台帳の不変条件（⑧）で
                    保存できないため出さない。操作の無い行は読み取り専用だが、その理由は
                    摘要の後ろのタグ（月割り・取消/返金・補正・初期残高）が既に名乗っている。 */}
                <div className="row-trailing">
                  <span
                    className={`list__amount ${balanceChangeClass}`.trim()}
                    aria-label={balanceChangeLabel}
                  >
                    <Money amount={displayedAmount} currency={currency} />
                  </span>
                  {isVirtual ||
                  isPurchase ||
                  isRuleGenerated ||
                  isAdjustment ||
                  isOpening ? null : isRecovery ? null : (
                    <button
                      type="button"
                      className="btn btn--tonal"
                      onClick={() => onReverse(entry)}
                      aria-label={`${t('journal.reverseAction')}: ${entry.description}`}
                      data-ui={UI.journal.entry.reverse}
                    >
                      {t('journal.reverseShort')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editingOpening ? (
        <OpeningEditSheet entry={editingOpening} onClose={() => setEditingOpening(null)} />
      ) : null}

      {editingAdjustment ? (
        <AdjustmentEditSheet entry={editingAdjustment} onClose={() => setEditingAdjustment(null)} />
      ) : null}
      <ScrollTopButton />
    </section>
  );
}
