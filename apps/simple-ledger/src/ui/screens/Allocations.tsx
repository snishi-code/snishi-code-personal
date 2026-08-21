/*
 * 月割り台帳。
 *  - くり返し記帳（定期ルール）: 実仕訳の自動起票（正本は起票された仕訳）。
 *    貸方・借方を簿記編集で直接指定し、行き先が費用なら自動で継続コスト台帳を経由する。
 *  - 継続コスト資産: 項目名・金額・開始日・終了日の4項目。終了日までの月割りは導出で、
 *    終了日を過ぎたら一覧から消える（アーカイブ = 終了日の設定）。
 *  - ローン（v13.6 H4）: 専用セクションは持たない。**計上先が負債科目のルール**が
 *    そのままローンで、持ち物・定期と同じ一覧に混在して並ぶ（検索・並び替えが一体で効く）。
 *    ルールを持たない負債（クレカ等）はここに出ない＝区別はルールの有無だけ。
 *    資金繰りの負債行タップ（target.liabilityAccountId）は該当ルール行へ着地する。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  compareMonthlyCostItems,
  isArchived,
  isEndingSoon,
  monthlyCostForMonth,
  remainingValue,
  representativeMonthlyAmount,
} from '../../domain/monthlyCost';
import {
  recoveredAmountsByItem,
  spreadTotalOf as computeSpreadTotal,
} from '../../domain/continuousCost';
import { generatedItemRuleId } from '../../domain/recurringIds';
import type { AccountRole } from '../../domain/accountRoles';
import { monthlyAmounts, monthOf } from '../../domain/allocation';
import { reportBasis, type ReportPeriod } from '../../domain/reportPeriod';
import { todayLocal } from '../../util/time';
import {
  deriveRecurringOutputs,
  recurringDestinationAccountId,
  recurringKindOf,
  type RecurringKind,
} from '../../domain/recurring';
import { reportMonthlyCostItems } from '../../domain/reportEntries';
import {
  accountExistsAt,
  effectiveRecurringRuleStartDate,
  recurringRuleLastExistingDate,
  ruleExistsAt as recurringRuleExistsAt,
} from '../../domain/accountLifetime';
import { cardTapProps, rowActionClick } from '../cardTap';
import {
  isLoanItem,
  loanItemForLiability,
  loanItemRemainingInstallments,
  loanItemSortAmount,
  loanSettledAmountsByItem,
  loanSpreadTotalOf,
} from '../../domain/loan';
import { Money } from '../money';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import type {} from '../../util/format';
import { UI } from '../../ui-contract';
import type {} from '../../data/repository';
import type { JournalEntry, MonthlyCostItem, RecurringRule } from '../../domain/types';
import { ScrollTopButton } from '../ScrollTopButton';
import { AddChooserSheet } from '../sheets/AddChooserSheet';
import { ContinuousCostItemSheet } from '../sheets/ContinuousCostItemSheet';
import { LoanItemSheet, LoanSettleSheet } from '../sheets/LoanSheets';
import { MonthlyCostArchiveSheet } from '../sheets/MonthlyCostArchiveSheet';
import {
  RecurringRuleEndSheet,
  RecurringRuleSwitchSheet,
} from '../sheets/RecurringRuleLifecycleSheets';
import { RecurringRuleSheet } from '../sheets/RecurringRuleSheet';

/** 仕訳一覧から「この行はどこから来たか」で遷移してくるときの対象。 */
export interface AllocationsTarget {
  itemId?: string;
  ruleId?: string;
  /**
   * 負債の科目（資金繰りの負債行タップ）。**その負債を計上先に持つルール行**へ着地する。
   * item / rule と違ってシートは開かず、該当行へスクロールする（目的地は行そのもの）。
   * ルールが無い負債（クレカ等）は台帳に居ないので、資金繰り側が勘定科目へ振り分ける。
   */
  liabilityAccountId?: string;
}

/**
 * 並び替え state。軸の集合は仕訳一覧と共通の正本（LIST_SORT_AXES）で、
 * 日付軸の意味だけがセクションごとに違う（継続コスト資産 = 終了日 / 定期ルール = 開始日）。
 */
interface ListSort {
  key: ListSortAxisKey;
  direction: SortDirection;
}

/**
 * 軸ごとの data-ui（軸の集合そのものは LIST_SORT_AXES が正本で、画面ごとに違うのはここだけ）。
 */
const SORT_AXIS_DATA_UI: Record<ListSortAxisKey, string> = {
  date: UI.allocations.sortByDate,
  amount: UI.allocations.sortByAmount,
  name: UI.allocations.sortByName,
};

/** 軸ごとの既定方向（日付 = 終了/開始が近い順・金額 = 大きい順・名称 = 五十音順）。軸を切り替えたらここへ戻す。 */
const SORT_DEFAULT_DIRECTION: Record<ListSortAxisKey, SortDirection> = {
  date: 'asc',
  amount: 'desc',
  name: 'asc',
};

export function Allocations({
  period,
  onEditEntry,
  target,
}: {
  /** ヘッダーで選んだ断面。「月割り台帳」の一覧・表示額だけがこの日付に追従する。 */
  period: ReportPeriod;
  /** 購入の仕訳を開く（開始日の変更は仕訳側で行う）。 */
  onEditEntry: (entry: JournalEntry) => void;
  /** 仕訳一覧の計算で生まれた行タップからの遷移対象（開くシート。同一オブジェクトは 1 回だけ消費）。 */
  target?: AllocationsTarget | null;
}) {
  const { ledger } = useLedger();
  const [showEnded, setShowEnded] = useState(false);
  const [query, setQuery] = useState('');
  // 並び替え（表示専用・保存しない）。軸と方向を 1 つの state で持ち、軸を切り替えたら
  // 方向を軸ごとの既定へ戻す（前の軸で選んだ方向が別の軸へ持ち越されない）。
  const [sort, setSort] = useState<ListSort>({ key: 'date', direction: 'asc' });
  const [itemSheet, setItemSheet] = useState<{ existing?: MonthlyCostItem } | null>(null);
  const [archiving, setArchiving] = useState<MonthlyCostItem | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [ruleSheet, setRuleSheet] = useState<{ existing?: RecurringRule } | null>(null);
  // 資金繰りから来た負債行の着地点（該当ローン item カードまでスクロールする・v13.13）。
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const focusedItemRef = useRef<HTMLDivElement | null>(null);
  // ローンの終了（一括返済）シート。
  const [settlingLoan, setSettlingLoan] = useState<MonthlyCostItem | null>(null);
  // 状態を変える操作は必ず確認を挟む（2026-08-15 作者合意）: 終了は終了日シート。
  const [endingRule, setEndingRule] = useState<RecurringRule | null>(null);
  // 切り替え = この日から別の線分（シートそのものが確認面なので前置きの確認は無い）。
  const [switchingRule, setSwitchingRule] = useState<RecurringRule | null>(null);
  // 表示も操作可否もヘッダーの断面（asOf）へ追従する（today 規約: 実 today は挙動境界に
  // しない・v13.12）。実 today を使うのは reportBasis の解決（ヘッダー既定）と、各シートの
  // 書込みの既定日だけ（ヘッダーは表示のタイムマシンであって書込日ではない）。
  const asOf = reportBasis(period, todayLocal()).asOf;
  const currentYm = monthOf(asOf);
  const currency = ledger?.settings.currency ?? '';

  const accountsMap = useMemo(
    () => new Map((ledger?.accounts ?? []).map((a) => [a.id, a] as const)),
    [ledger],
  );
  const name = (id?: string): string => (id ? (accountsMap.get(id)?.name ?? '—') : '—');

  // 回収の振替を差し引いた「割り振る総額」（負になってよい＝過去にわたる費用減）。
  // 導出パラメータは常に現在わかっている全実仕訳から求める。後日の回収も全期間へ
  // 遡及して再配分されるため、ヘッダーの断面を変えても同じ item の月額は変わらない。
  // 検索の毎打鍵で再レンダーが走るため、全仕訳走査は useMemo で 1 回にする。
  const recovered = useMemo(() => recoveredAmountsByItem(ledger?.journalEntries ?? []), [ledger]);
  // ローンの一括返済の合計（spreadTotal = 借入総額 − 一括返済。回収の振替と同じ流儀）。
  const settled = useMemo(() => loanSettledAmountsByItem(ledger?.journalEntries ?? []), [ledger]);
  // 式は domain の単一正本（continuousCost.spreadTotalOf / loan.loanSpreadTotalOf）に委譲する。
  const spreadTotalOf = (m: MonthlyCostItem): number =>
    isLoanItem(m) ? loanSpreadTotalOf(m, settled) : computeSpreadTotal(m, recovered);
  // 購入の仕訳（item と 1:1・最初に一致した 1 件 = 従来の find と同じ規則）。
  // ローン item は借入の仕訳（loanItemId・loanSettlement なし）が同じ役を担う。
  const purchaseEntryByItem = useMemo(() => {
    const map = new Map<string, JournalEntry>();
    for (const e of ledger?.journalEntries ?? []) {
      const id = e.metadata?.monthlyCostId;
      if (id !== undefined && e.metadata?.monthlyCostRecovery !== true && !map.has(id)) {
        map.set(id, e);
      }
      const loanId = e.metadata?.loanItemId;
      if (loanId !== undefined && e.metadata?.loanSettlement !== true && !map.has(loanId)) {
        map.set(loanId, e);
      }
    }
    return map;
  }, [ledger]);
  const purchaseEntryOf = (m: MonthlyCostItem): JournalEntry | undefined =>
    purchaseEntryByItem.get(m.id);

  // v13: ルール由来 item は保存されない。ヘッダー断面までを導出して手動 item と合成する
  // （集計と同じ単一正本 reportMonthlyCostItems。保存に残る ccr- は読まない）。
  const derivedRecurring = useMemo(
    () => deriveRecurringOutputs(ledger?.recurringRules ?? [], ledger?.accounts ?? [], asOf),
    [ledger, asOf],
  );
  const allItems = useMemo(
    () =>
      reportMonthlyCostItems(
        { monthlyCostItems: ledger?.monthlyCostItems ?? [] },
        derivedRecurring.items,
      ),
    [ledger, derivedRecurring],
  );
  // 開始前の項目はその断面にはまだ存在しない。showEnded は終了済みだけを再表示し、
  // 未来開始の項目まで先取りしない。
  const startedItems = allItems.filter((m) => m.startDate <= asOf);
  const allRules = ledger?.recurringRules ?? [];
  const rulesById = useMemo(
    () => new Map((ledger?.recurringRules ?? []).map((r) => [r.id, r] as const)),
    [ledger],
  );
  const startedRules = allRules.filter((r) => effectiveRecurringRuleStartDate(r) <= asOf);
  // 「終了分も表示」の出現条件は検索前の全件で判定する（検索で 0 件になっても、
  // 母集合を変える唯一のコントロールを消さない）。
  const hasEndedAtAsOf =
    startedRules.some((r) => !recurringRuleExistsAt(r, asOf)) ||
    startedItems.some((m) => isArchived(m, asOf));
  // 額縁（検索・並び替え）は「この画面に出す行が 1 つでもあるか」で決める。
  const hasAnyStarted = startedRules.length > 0 || startedItems.length > 0;

  // 検索: 1 つの検索欄が全セクションに効く（「終了分も表示」と同じ単一 state の型）。
  // 対象 = 名前 + 関係する科目名（Journal と同じ範囲。金額・日付・種別タグは対象外）。
  const dir = directionSign(sort.direction);
  // 日付軸の意味はセクションごとに違う（継続コスト資産 = 終了日 / 定期ルール = 開始日）。
  // 終了日なしは「いつ終わるか分からない」なので昇順・降順どちらでも最後に置く（方向を
  // 掛ける前に決着させる）。同着はどちらの方向でも名前の五十音順で安定化する。
  const itemCompare =
    sort.key === 'date'
      ? (a: MonthlyCostItem, b: MonthlyCostItem) => {
          if (a.endDate === undefined || b.endDate === undefined) {
            if (a.endDate === b.endDate) return a.name.localeCompare(b.name, 'ja');
            return a.endDate === undefined ? 1 : -1;
          }
          if (a.endDate !== b.endDate) return (a.endDate < b.endDate ? -1 : 1) * dir;
          return a.name.localeCompare(b.name, 'ja');
        }
      : sort.key === 'amount'
        ? // ローン item の額は負として比べる（v13.7 I4 の規約を item へ継承）。昇順で
          // −10,000 が 3,300 より前に来る＝返済と持ち物が絶対値で混ざらない。
          // 表示は絶対値 + 負債色のまま（loanItemSortAmount）。
          (a: MonthlyCostItem, b: MonthlyCostItem) =>
            (loanItemSortAmount(a) - loanItemSortAmount(b)) * dir
        : (a: MonthlyCostItem, b: MonthlyCostItem) => a.name.localeCompare(b.name, 'ja') * dir;
  const ruleCompare =
    sort.key === 'date'
      ? (a: RecurringRule, b: RecurringRule) => {
          const sa = effectiveRecurringRuleStartDate(a);
          const sb = effectiveRecurringRuleStartDate(b);
          if (sa !== sb) return (sa < sb ? -1 : 1) * dir;
          return a.name.localeCompare(b.name, 'ja');
        }
      : sort.key === 'amount'
        ? (a: RecurringRule, b: RecurringRule) => (a.amount - b.amount) * dir
        : (a: RecurringRule, b: RecurringRule) => a.name.localeCompare(b.name, 'ja') * dir;
  // loadLedger は終了が近い順で返すが、編集直後の state 由来でも順序が崩れないよう再ソートする。
  // この基準順は金額・名称の軸で同値になった行の相対順（applySort は安定ソート）も決める。
  // ルール由来 item（導出）と手動 item は allItems で既に合成済み。見た目・操作も同型
  // （「予定」等の区別タグは付けず、タップはルール由来なら由来ルールへ）。
  const items = applySort(
    startedItems
      .filter((m) => showEnded || !isArchived(m, asOf))
      .filter((m) => matchesQuery([m.name, accountsMap.get(m.expenseAccountId)?.name], query))
      .sort((a, b) => compareMonthlyCostItems(a, b)),
    itemCompare,
  );
  // 定期ルールは loadLedger の createdAt 昇順で届く。日付軸（開始日）以外では同値の相対順が
  // この登録順になる。
  const rules = applySort(
    startedRules
      .filter((r) => showEnded || recurringRuleExistsAt(r, asOf))
      .filter((r) =>
        matchesQuery(
          [
            r.name,
            accountsMap.get(r.creditAccountId)?.name,
            accountsMap.get(recurringDestinationAccountId(r))?.name,
          ],
          query,
        ),
      ),
    ruleCompare,
  );
  // 参照科目が削除済み、または選択断面で存在期間外なら行で警告する。
  // catch-up も各起票日の科目存在期間を照合して fail-soft に起票を止める。
  const ruleRefBroken = (r: RecurringRule): boolean => {
    const referenceDate = recurringRuleExistsAt(r, asOf)
      ? asOf
      : (recurringRuleLastExistingDate(r) ?? asOf);
    const ids = [r.creditAccountId, recurringDestinationAccountId(r)];
    return ids.some((id) => {
      const account = accountsMap.get(id);
      return !account || !accountExistsAt(account, referenceDate);
    });
  };
  const ruleKindLabel = (r: RecurringRule): string => {
    const kind = sheetKindForRule(r, (id) => accountsMap.get(id)?.role);
    return t(`recurring.kind.${kind}` as MessageKey);
  };
  const ruleIntervalLabel = (r: RecurringRule): string =>
    r.everyMonths >= 2
      ? t('recurring.everyNMonthsDay', { n: r.everyMonths, day: r.dayOfMonth })
      : t('recurring.everyMonthDay', { day: r.dayOfMonth });

  // 検索でどちらのセクションも 0 件（データが無いのではなく絞り込みで消えた）。
  const searchMissed = query !== '' && rules.length === 0 && items.length === 0;

  // 資金繰りから来た負債行を画面内へ運ぶ（消費は下の target 解決・スクロールは描画後）。
  useEffect(() => {
    if (focusedItemId === null) return;
    focusedItemRef.current?.scrollIntoView?.({ block: 'center' });
  }, [focusedItemId]);

  // 仕訳一覧の計算で生まれた行タップからの遷移: 対象のシートを開く。
  // effect ではなく「render 中の派生調整」パターン（同一 target は 1 回だけ消費する）。
  const [consumedTarget, setConsumedTarget] = useState<AllocationsTarget | null>(null);
  if (target != null && target !== consumedTarget && ledger) {
    setConsumedTarget(target);
    // 検索語が残っていると、開いたシートを閉じた直後に対象が一覧に居ない状態になるため
    // 消費と同時にクリアする（探索自体はフィルタ前の全件に対して行う）。
    setQuery('');
    const targetItem =
      target.itemId !== undefined ? allItems.find((m) => m.id === target.itemId) : undefined;
    const targetRule =
      target.ruleId !== undefined ? allRules.find((r) => r.id === target.ruleId) : undefined;
    // 負債は「行そのもの」が目的地。シートは開かず、該当ローン item カードを視界へ入れる
    // （ローン item が無ければ何も起きない = fail-closed。資金繰り側が勘定科目へ振り分ける）。
    const targetLoanItem =
      target.liabilityAccountId !== undefined
        ? loanItemForLiability(allItems, target.liabilityAccountId)
        : undefined;
    if (targetItem) setItemSheet({ existing: targetItem });
    else if (targetRule) setRuleSheet({ existing: targetRule });
    else if (targetLoanItem) setFocusedItemId(targetLoanItem.id);
  }

  return (
    <section
      className="allocations"
      aria-labelledby="allocations-title"
      data-ui={UI.allocations.view}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 className="screen-title" id="allocations-title" style={{ marginBottom: 0 }}>
          {t('monthly.title')}
        </h1>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setChooserOpen(true)}
          data-ui={UI.allocations.unifiedAdd}
        >
          <Icon name="add" size={16} />
          {t('monthly.add')}
        </button>
      </div>

      {/* 絞り込み額縁: 「終了分も表示」・検索・並び替えを sticky で上端に固定し、
          ルール一覧と item カードだけが下を流れる（作者合意 2026-08-15・ホームの額縁と同型）。
          h1 と「追加」は含めない = スクロールで流れてよい。
          余白は額縁の gap が持つので、中の行に margin は置かない。
          hasEndedAtAsOf は startedRules/startedItems から導くので hasAnyStarted を含意する
          （= 額縁が「終了分も表示」だけで出ることはない）。 */}
      {hasAnyStarted ? (
        <div className="list-filter-frame" data-ui={UI.allocations.filterFrame}>
          {hasEndedAtAsOf ? (
            <label
              style={{
                display: 'inline-flex',
                gap: 8,
                alignItems: 'center',
                minHeight: 'var(--tap)',
                // 額縁は縦 flex。既定の stretch では全幅ラベルになり、右の余白を押しても
                // チェックが切り替わってしまう。従来どおり中身ぶんだけに留める。
                alignSelf: 'flex-start',
              }}
            >
              <input
                type="checkbox"
                checked={showEnded}
                onChange={(e) => setShowEnded(e.target.checked)}
                data-ui={UI.allocations.showCompleted}
              />
              {t('monthlyCost.showEnded')}
            </label>
          ) : null}
          <div className="toolbar">
            <SearchInput
              id="allocations-search"
              label={t('common.search')}
              value={query}
              onChange={setQuery}
              placeholder={t('monthly.searchPlaceholder')}
              dataUi={UI.allocations.search}
            />
          </div>
          <SortControls
            ariaLabel={t('common.sort')}
            axisItems={LIST_SORT_AXES.map((axis) => ({
              key: axis.key,
              label: t(axis.labelKey),
              dataUi: SORT_AXIS_DATA_UI[axis.key],
            }))}
            axisValue={sort.key}
            onAxisChange={(key) => {
              const next = listSortAxisKey(key);
              // 軸を変えたら方向は軸ごとの既定へ戻す（前の軸の方向を持ち越さない）。
              setSort({ key: next, direction: SORT_DEFAULT_DIRECTION[next] });
            }}
            directionItems={[
              { key: 'desc', label: t('common.sortDesc'), dataUi: UI.allocations.sortDesc },
              { key: 'asc', label: t('common.sortAsc'), dataUi: UI.allocations.sortAsc },
            ]}
            directionValue={sort.direction}
            onDirectionChange={(key) =>
              setSort((s) => ({ ...s, direction: key === 'asc' ? 'asc' : 'desc' }))
            }
          />
          {/* 絞り込み結果を読み上げる（検索は視覚的にしか結果が分からないため）。 */}
          <p className="sr-only" role="status" data-ui={UI.allocations.searchCount}>
            {query === ''
              ? ''
              : t('monthly.searchCount', { rules: rules.length, items: items.length })}
          </p>
        </div>
      ) : null}

      {!hasAnyStarted ? (
        <div className="card card--pad empty" style={{ margin: 'var(--space-3) 0 var(--space-4)' }}>
          <Icon name="calendar" size={28} />
          <p style={{ marginTop: 'var(--space-3)' }}>{t('monthly.empty')}</p>
        </div>
      ) : searchMissed ? (
        // 検索でヒット 0 件（データが無いのではなく絞り込みで消えた）。案内文とは排他。
        <div
          className="card card--pad empty"
          style={{ margin: 'var(--space-3) 0 var(--space-4)' }}
          data-ui={UI.allocations.searchEmpty}
        >
          {t('monthly.searchEmpty')}
        </div>
      ) : null}

      {rules.length === 0 ? null : (
        <>
          <p className="section-label" style={{ marginTop: 'var(--space-3)' }}>
            {t('recurring.sectionTitle')}
          </p>
          <ul
            className="card list"
            style={{ marginBottom: 'var(--space-4)' }}
            data-ui={UI.allocations.recurringList}
          >
            {rules.map((r) => {
              const activeAtAsOf = recurringRuleExistsAt(r, asOf);
              // 終了点が既に入っているルールは、押しても同じ終了点を書き直すだけなので出さない。
              // 切り替えの出現条件は終了と同じ（**断面 asOf の日に存在**していて終了点が未設定。
              // 半開区間そのままなので開始日 = 断面当日も含む・v13.12 today 規約）。
              // どちらも「この日で旧線分を閉じる」操作で、後継を作るかどうかだけが違う。
              const canClose = activeAtAsOf && r.endDate === undefined;
              // 操作ボタンが出ない行（= 終了点あり）も、右列の同じ位置を状態チップで埋める
              // （v13.2）。空けると縦揃えが崩れ、「なぜボタンが無いか」も読めなくなる。
              const status =
                r.endDate !== undefined
                  ? activeAtAsOf
                    ? {
                        // 「いつまで動くか」を日付で名乗る（終了済みとの違いが読める）。
                        label: t('recurring.statusEndScheduled', {
                          date: recurringRuleLastExistingDate(r) ?? r.endDate,
                        }),
                        tone: 'warning',
                      }
                    : { label: t('recurring.statusEnded'), tone: 'neutral' }
                  : // 終了点なしは canClose 側に必ず入る（startedRules が開始 <= asOf を保証）。
                    { label: t('recurring.ruleNoEnd'), tone: 'neutral' };
              return (
                // 行そのものをタップ = そのルールの編集シート（カードタップ = 編集の単一正本）。
                // 行の中に終了・切替のボタンが残るため <button> にはできない（入れ子不正）。
                // 削除・解除は編集シート最下部（動詞体系 v13.1）・再開は撤去
                //（実体は新規登録と同じで「終了の Undo」と誤読させるため）。
                <li key={r.id}>
                  <div
                    className="list__item"
                    {...cardTapProps(`${t('common.edit')}: ${r.name}`, () =>
                      setRuleSheet({ existing: r }),
                    )}
                  >
                    <div className="list__main">
                      <div className="list__title">
                        {r.name} <span className="tag tag--teal">{ruleKindLabel(r)}</span>
                      </div>
                      <div className="list__sub">
                        {t('recurring.rulePeriod')}: {effectiveRecurringRuleStartDate(r)} 〜{' '}
                        {r.endDate !== undefined
                          ? t('recurring.ruleEndBefore', { date: r.endDate })
                          : t('recurring.ruleNoEnd')}
                      </div>
                      <div className="list__sub">
                        {t('recurring.postingSchedule')}: {ruleIntervalLabel(r)}・
                        {name(r.creditAccountId)} → {name(recurringDestinationAccountId(r))}・
                        {t('monthlyCost.monthly')}{' '}
                        <Money
                          amount={monthlyAmounts(r.amount, r.everyMonths)[0] ?? 0}
                          currency={currency}
                        />
                      </div>
                      {ruleRefBroken(r) ? (
                        <div className="field__error" role="alert">
                          {t('recurring.refBroken')}
                        </div>
                      ) : null}
                    </div>
                    {/* 右列 = 上段 金額 / 下段 操作（または状態）。行をまたいで縦に揃う。 */}
                    <div className="row-trailing">
                      <span className="list__amount">
                        <Money amount={r.amount} currency={currency} />
                      </span>
                      {/* 一等地の動詞は tonal ボタン（v13.2: 押せる面を持たせる）。 */}
                      {canClose ? (
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn btn--tonal"
                            onClick={rowActionClick(() => setSwitchingRule(r))}
                            aria-label={`${t('recurring.switch')}: ${r.name}`}
                            data-ui={UI.allocations.recurringSwitch}
                          >
                            {t('recurring.switchShort')}
                          </button>
                          <button
                            type="button"
                            className="btn btn--tonal"
                            onClick={rowActionClick(() => setEndingRule(r))}
                            aria-label={`${t('recurring.end')}: ${r.name}`}
                            data-ui={UI.allocations.recurringEnd}
                          >
                            {t('recurring.end')}
                          </button>
                        </div>
                      ) : (
                        <span
                          className={`tag tag--${status.tone}`}
                          data-ui={UI.allocations.recurringStatus}
                        >
                          {status.label}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {items.length === 0 ? null : (
        <>
          <p className="section-label" style={{ marginBottom: 'var(--space-2)' }}>
            {t('monthlyCost.sectionTitle')}
          </p>
          <div className="stack" data-ui={UI.allocations.list}>
            {items.map((m) => {
              // 回収は実仕訳（monthlyCostRecovery）から導出する。導出 item も決定的 ID で
              // 同じ回収に到達する（清算後の spreadTotal = amount − 回収額）。
              // ローン item の spreadTotal は 借入総額 − 一括返済（loanSettlement）。
              const spreadTotal = spreadTotalOf(m);
              const loan = isLoanItem(m);
              // ルール由来 item は読み取り専用（作者決定 2026-08-15）。行アクションは出さず、
              // タップは由来ルールへ。判定は単一正本 generatedItemRuleId。
              const originRule = rulesById.get(generatedItemRuleId(m) ?? '');
              const fromRuleItem = generatedItemRuleId(m) !== undefined;
              // 由来ルールが引けない ccr-（カスケード削除の取りこぼし等の破損データ）は
              // 開く先が無い＝押せる見た目にしない（誤って編集シートへ流さない・fail-closed）。
              const open =
                originRule !== undefined
                  ? () => setRuleSheet({ existing: originRule })
                  : fromRuleItem
                    ? undefined
                    : () => setItemSheet({ existing: m });
              const ending = isEndingSoon(m, asOf);
              const monthly = representativeMonthlyAmount(m, spreadTotal);
              return (
                // カードそのものをタップ = 編集。手で登録した item は継続コスト資産シート
                // （ローンはローンの編集シート）、ルール由来は由来のルールのシートを開く。
                <div
                  className={`card card--pad${ending ? ' card--ending' : ''}`}
                  key={m.id}
                  ref={focusedItemId === m.id ? focusedItemRef : undefined}
                  data-ui={UI.allocations.item}
                  data-ending={ending ? 'true' : undefined}
                  data-derived-rule={fromRuleItem ? originRule?.id : undefined}
                  {...(loan ? { 'data-account-id': m.expenseAccountId } : {})}
                  {...(open !== undefined
                    ? cardTapProps(`${t('common.edit')}: ${originRule?.name ?? m.name}`, open)
                    : {})}
                >
                  {/* ルール行と同じ設計図（v13.2）: 左 = 名前 / 右列 = 上段 金額・下段 操作
                      （または状態）。金額の kv 行は右列へ移したぶん重複を避けて外す。 */}
                  <div
                    className="list__title"
                    style={{
                      marginBottom: 'var(--space-2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 'var(--space-3)',
                    }}
                  >
                    <span>
                      {m.name}
                      {loan ? (
                        <>
                          {' '}
                          <span className="tag tag--teal">{t('monthlyCost.loanTag')}</span>
                        </>
                      ) : null}
                    </span>
                    <span className="row-trailing">
                      <span className="list__amount">
                        {/* ローンの額は負債の色（表示は絶対値のまま・符号は付けない）。 */}
                        <Money
                          amount={m.amount}
                          currency={currency}
                          {...(loan ? { tone: 'liability' as const } : {})}
                        />
                      </span>
                      {fromRuleItem /* ルール由来 item は読み取り専用: 終了も削除も出さない
                           （導出カードは実在しないので元から対象が無い。保存済み ccr- も
                           「生まれたものへの個別操作は不可」＝調整は由来ルール側で行う）。
                           ボタンの代わりに由来を名乗るチップを同じ位置へ置く（v13.2:
                           縦揃えを崩さず「なぜボタンが無いか」も読める）。 */ ? (
                        <span className="tag tag--teal">{t('monthlyCost.fromRule')}</span>
                      ) : loan ? (
                        // ローンの「終了」= 一括返済（§2.4）。ルールの「切替」は無い —
                        // 条件変更 = 編集（全期間引き直し）か 終了 の 2 択（仕様差 3）。
                        <button
                          type="button"
                          className="btn btn--tonal"
                          onClick={rowActionClick(() => setSettlingLoan(m))}
                          aria-label={`${t('loan.settleTitle')}: ${m.name}`}
                          data-ui={UI.allocations.loanSettle}
                        >
                          {t('recurring.end')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--tonal"
                          onClick={rowActionClick(() => setArchiving(m))}
                          aria-label={`${t('ccItem.archiveTitle')}: ${m.name}`}
                          data-ui={UI.allocations.archive}
                        >
                          {t('ccItem.archiveTitle')}
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="muted">{t('monthlyCost.monthly')}</span>
                    <span>
                      {m.endDate === undefined ? (
                        '—'
                      ) : (
                        <Money amount={monthly} currency={currency} />
                      )}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="muted">{t('ccItem.period')}</span>
                    <span>
                      {m.startDate} 〜 {m.endDate ?? '—'}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="muted">
                      {loan ? t('loan.remainingDebt') : t('ccItem.remainingValue')}
                    </span>
                    <span>
                      <Money amount={remainingValue(m, asOf, spreadTotal)} currency={currency} />
                    </span>
                  </div>
                  {loan ? (
                    <div className="kv" data-ui={UI.allocations.loanRemaining}>
                      <span className="muted">{t('loan.installments')}</span>
                      <span>
                        {t('repay.installmentsLeft', {
                          count: loanItemRemainingInstallments(m, asOf, spreadTotal),
                        })}
                      </span>
                    </div>
                  ) : null}
                  <div className="kv">
                    <span className="muted">{t('monthlyCost.thisMonth')}</span>
                    <span>
                      <Money
                        amount={monthlyCostForMonth(m, currentYm, spreadTotal)}
                        currency={currency}
                      />
                    </span>
                  </div>
                  <div className="kv">
                    <span className="muted">{t('monthlyCost.expenseCategory')}</span>
                    <span>{name(m.expenseAccountId)}</span>
                  </div>
                  {loan ? (
                    <div className="kv">
                      <span className="muted">{t('loan.repaymentSource')}</span>
                      <span>{name(m.repaymentSourceAccountId)}</span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}

      {itemSheet ? (
        itemSheet.existing !== undefined && isLoanItem(itemSheet.existing) ? (
          <LoanItemSheet
            existing={itemSheet.existing}
            purchaseEntry={purchaseEntryOf(itemSheet.existing)}
            onOpenPurchase={onEditEntry}
            onClose={() => setItemSheet(null)}
          />
        ) : (
          <ContinuousCostItemSheet
            {...(itemSheet.existing !== undefined ? { existing: itemSheet.existing } : {})}
            {...(itemSheet.existing !== undefined
              ? { purchaseEntry: purchaseEntryOf(itemSheet.existing) }
              : {})}
            onOpenPurchase={onEditEntry}
            onClose={() => setItemSheet(null)}
          />
        )
      ) : null}

      {archiving ? (
        <MonthlyCostArchiveSheet
          item={archiving}
          spreadTotal={spreadTotalOf(archiving)}
          onClose={() => setArchiving(null)}
        />
      ) : null}

      {settlingLoan ? (
        <LoanSettleSheet
          item={settlingLoan}
          spreadTotal={spreadTotalOf(settlingLoan)}
          onClose={() => setSettlingLoan(null)}
        />
      ) : null}

      {chooserOpen ? (
        <AddChooserSheet
          onClose={() => setChooserOpen(false)}
          onPick={(pick) => {
            setChooserOpen(false);
            if (pick === 'asset') setItemSheet({});
            else setRuleSheet({});
          }}
        />
      ) : null}

      {ruleSheet ? (
        <RecurringRuleSheet
          {...(ruleSheet.existing !== undefined ? { existing: ruleSheet.existing } : {})}
          asOf={asOf}
          onClose={() => setRuleSheet(null)}
        />
      ) : null}

      {endingRule ? (
        <RecurringRuleEndSheet rule={endingRule} onClose={() => setEndingRule(null)} />
      ) : null}

      {switchingRule ? (
        <RecurringRuleSwitchSheet rule={switchingRule} onClose={() => setSwitchingRule(null)} />
      ) : null}

      <ScrollTopButton />
    </section>
  );
}

/** 一覧で導出表示する種別。保存フィールドではない。 */
type SheetKind = RecurringKind | 'manual';

/**
 * ルールの表示・編集用の種別（保存しない）。利用者が指定した論理的な行き先と
 * 源泉の role から導出する（費用ルールの保存上の借方=内部台帳は判定に使わない）。
 * v13.13: 計上先が負債のルール（旧形ローン）は保存境界・wire が拒否するので、
 * ここにローンの分岐は無い（ローンは item カード側の世界）。
 */
function sheetKindForRule(
  rule: RecurringRule,
  roleOf: (id: string) => AccountRole | undefined,
): SheetKind {
  return (
    recurringKindOf(roleOf(recurringDestinationAccountId(rule)), roleOf(rule.creditAccountId)) ??
    'manual'
  );
}
