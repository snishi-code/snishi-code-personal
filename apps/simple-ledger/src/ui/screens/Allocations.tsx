/*
 * 月割り台帳。
 *  - くり返し記帳（定期ルール）: 実仕訳の自動起票（正本は起票された仕訳）。
 *    貸方・借方を簿記編集で直接指定し、行き先が費用なら自動で継続コスト台帳を経由する。
 *  - 継続コスト資産: 項目名・金額・開始日・終了日の4項目。終了日までの月割りは導出で、
 *    終了日を過ぎたら一覧から消える（アーカイブ = 終了日の設定）。
 *  - 支払用負債（v13.4 ④ で資金繰りから移設）: カード・ローンの返済予定を登録・編集する。
 *    行は**基準日断面で残高 ≠ 0**（資金繰りと同じ domain の liabilityScheduleRows）。
 *    資金繰りの負債行タップ（target.liabilityAccountId）がここへ着地する。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../overlays';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { AccountPicker } from '../AccountPicker';
import { FlowField } from '../FlowField';
import {
  LIST_SORT_AXES,
  SearchInput,
  SortControls,
  listSortAxisKey,
  type ListSortAxisKey,
} from '../ListSearchSort';
import { applySort, directionSign, matchesQuery, type SortDirection } from '../listQuery';
import { ConfirmDialog } from '../overlays';
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
import { generatedItemRuleId, parseRuleItemId } from '../../domain/recurringIds';
import type { AccountRole } from '../../domain/accountRoles';
import { lastExpenseCategoryId, rememberExpenseCategoryId } from '../../data/localFlags';
import { sortAccounts } from '../../domain/accountOrder';
import {
  defaultMonthlyAllocationAccountId,
  groupedAccountsByRole,
  groupedRecoveryDestinationAccounts,
  monthlyAllocationAccountOptions,
} from '../accountOptions';
import { monthlyAmounts, monthOf } from '../../domain/allocation';
import { debitSignedBalance, deriveBalanceSheet } from '../../domain/accounting';
import { liabilityScheduleRows, repaymentEntryAmount } from '../../domain/cashflow';
import { RepaymentScheduleSheet } from '../RepaymentScheduleSheet';
import { isValidIsoDate } from '../../domain/calendar';
import { reportBasis, type ReportPeriod } from '../../domain/reportPeriod';
import { nowIso, todayLocal } from '../../util/time';
import {
  CATCH_UP_HARD_CAP_MONTHS,
  RECURRING_POSTABLE_ROLES,
  clampDayToMonth,
  deriveRecurringOutputs,
  firstRecurringPostingDate,
  recurringDestinationAccountId,
  recurringKindOf,
  type RecurringKind,
} from '../../domain/recurring';
import { displayEntriesResultForAsOf, reportMonthlyCostItems } from '../../domain/reportEntries';
import {
  accountExistsAt,
  earliestRecurringRuleEndDate,
  effectiveRecurringRuleStartDate,
  recurringRuleLastExistingDate,
  ruleExistsAt as recurringRuleExistsAt,
} from '../../domain/accountLifetime';
import { cardTapProps, rowActionClick } from '../cardTap';
import { quickSpanEndDate } from '../ccQuickSpan';
import {
  exactDigitsFor,
  formatMinorForInput,
  parseAmountToMinor,
  sanitizeAmountText,
} from '../amountText';
import { useMoneyDigits } from '../money';
import { Money, moneyText } from '../money';
import { errorText, t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import type { FractionDigits } from '../../util/format';
import { UI } from '../../ui-contract';
import type { RecurringRuleSettlementInput } from '../../data/repository';
import type { Account, JournalEntry, MonthlyCostItem, RecurringRule } from '../../domain/types';
import { ScrollTopButton } from '../ScrollTopButton';

/** 仕訳一覧から「この行はどこから来たか」で遷移してくるときの対象。 */
export interface AllocationsTarget {
  itemId?: string;
  ruleId?: string;
  /**
   * 支払用負債の行（資金繰りの負債行タップ）。item / rule と違ってシートは開かず、
   * 該当行へスクロールして登録済みの返済を展開する（見に来た人の目的地は行そのもの）。
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
  // 支払用負債（v13.4 ④）: 返済シート・登録済み返済の展開・資金繰りから来た行の着地点。
  const [repayFor, setRepayFor] = useState<{ account: Account; balance: number } | null>(null);
  const [openRepayments, setOpenRepayments] = useState<ReadonlySet<string>>(new Set());
  const [focusedLiabilityId, setFocusedLiabilityId] = useState<string | null>(null);
  const focusedLiabilityRef = useRef<HTMLLIElement | null>(null);
  // 状態を変える操作は必ず確認を挟む（2026-08-15 作者合意）: 終了は終了日シート。
  const [endingRule, setEndingRule] = useState<RecurringRule | null>(null);
  // 切り替え = この日から別の線分（シートそのものが確認面なので前置きの確認は無い）。
  const [switchingRule, setSwitchingRule] = useState<RecurringRule | null>(null);
  // 表示だけはヘッダーの断面へ追従する。シート内の書込日・catch-up は period を受け取らず、
  // 引き続き実際の今日を基準にする（過去/未来表示が durable state を動かさない）。
  const today = todayLocal();
  const asOf = reportBasis(period, today).asOf;
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
  // 式は domain の単一正本（continuousCost.spreadTotalOf）に委譲する。
  const spreadTotalOf = (m: MonthlyCostItem): number => computeSpreadTotal(m, recovered);
  // 購入の仕訳（item と 1:1・最初に一致した 1 件 = 従来の find と同じ規則）。
  const purchaseEntryByItem = useMemo(() => {
    const map = new Map<string, JournalEntry>();
    for (const e of ledger?.journalEntries ?? []) {
      const id = e.metadata?.monthlyCostId;
      if (id !== undefined && e.metadata?.monthlyCostRecovery !== true && !map.has(id)) {
        map.set(id, e);
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
  /*
   * 支払用負債（v13.4 ④）。行集合は資金繰りと同じ domain の単一正本を通す
   * （基準日断面で導出残高 ≠ 0 の payment/other-liability だけ）。
   * 残高は「その断面までの導出込み仕訳」から求める。断面より後の仕訳は残高に効かないので、
   * 資金繰りが地平まで展開して同じ日で切った結果と一致する（reportEntries.ts の不変則）。
   * 返済予定そのものは**保存された実仕訳**から引く（導出行は数えない）。
   */
  const liabilities = useMemo(() => {
    if (!ledger) return [];
    const entries = displayEntriesResultForAsOf(ledger, asOf).entries;
    const bs = deriveBalanceSheet(ledger.accounts, entries, asOf);
    return liabilityScheduleRows({
      accounts: ledger.accounts,
      storedEntries: ledger.journalEntries,
      balanceById: new Map(bs.liabilities.map((l) => [l.account.id, l.balance] as const)),
      asOf,
    });
  }, [ledger, asOf]);
  // 「終了分も表示」の出現条件は検索前の全件で判定する（検索で 0 件になっても、
  // 母集合を変える唯一のコントロールを消さない）。
  const hasEndedAtAsOf =
    startedRules.some((r) => !recurringRuleExistsAt(r, asOf)) ||
    startedItems.some((m) => isArchived(m, asOf));
  // 額縁（検索・並び替え）は「この画面に出す行が 1 つでもあるか」で決める。支払用負債も
  // 検索の対象なので母集合に数える（負債しか無い台帳でも検索欄が消えない）。
  const hasAnyStarted =
    startedRules.length > 0 || startedItems.length > 0 || liabilities.length > 0;

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
        ? (a: MonthlyCostItem, b: MonthlyCostItem) => (a.amount - b.amount) * dir
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

  // 検索は 1 つの欄が全セクションに効く（負債は科目名で当てる）。
  // 金額軸だけは負債セクションにも効かせる（C-2）。比較は**自然符号**（貸方残高は負）で
  // 行うので、昇順ではローン（最も大きな負債）が先頭に来る。表示は絶対値のまま。
  // 日付軸（次回返済日）・名称軸は導入せず、従来どおり科目順（sortAccounts）を保つ。
  const shownLiabilities = applySort(
    liabilities.filter((l) => matchesQuery([l.name], query)),
    sort.key === 'amount'
      ? (a, b) =>
          (debitSignedBalance(a.account.type, a.balance) -
            debitSignedBalance(b.account.type, b.balance)) *
          dir
      : null,
  );
  // 検索でどのセクションも 0 件（データが無いのではなく絞り込みで消えた）。
  const searchMissed =
    query !== '' && rules.length === 0 && items.length === 0 && shownLiabilities.length === 0;

  const toggleRepayments = (id: string) =>
    setOpenRepayments((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 資金繰りから来た負債行を画面内へ運ぶ（消費は下の target 解決・スクロールは描画後）。
  useEffect(() => {
    if (focusedLiabilityId === null) return;
    focusedLiabilityRef.current?.scrollIntoView?.({ block: 'center' });
  }, [focusedLiabilityId]);

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
    // 負債は「行そのもの」が目的地。シートは開かず、該当行を展開して視界へ入れる
    // （断面で残高 0 になっていて行が無ければ、何も起きない = fail-closed）。
    const targetLiability =
      target.liabilityAccountId !== undefined
        ? liabilities.find((l) => l.id === target.liabilityAccountId)
        : undefined;
    if (targetItem) setItemSheet({ existing: targetItem });
    else if (targetRule) setRuleSheet({ existing: targetRule });
    else if (targetLiability) {
      setFocusedLiabilityId(targetLiability.id);
      setOpenRepayments((prev) => new Set(prev).add(targetLiability.id));
    }
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
              : t('monthly.searchCount', {
                  rules: rules.length,
                  items: items.length,
                  liabilities: shownLiabilities.length,
                })}
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
              const start = effectiveRecurringRuleStartDate(r);
              const activeToday = recurringRuleExistsAt(r, today);
              // 終了点が既に入っているルールは、押しても同じ終了点を書き直すだけなので出さない。
              // 切り替えの出現条件は終了と同じ（今日存在していて終了点が未設定）。
              // どちらも「この日で旧線分を閉じる」操作で、後継を作るかどうかだけが違う。
              const canEndToday = activeToday && start < today && r.endDate === undefined;
              // 操作ボタンが出ない行も、右列の同じ位置を状態チップで埋める（v13.2）。
              // 空けると縦揃えが崩れ、「なぜボタンが無いか」も読めなくなる。
              const status =
                r.endDate !== undefined
                  ? activeToday
                    ? {
                        // 「いつまで動くか」を日付で名乗る（終了済みとの違いが読める）。
                        label: t('recurring.statusEndScheduled', {
                          date: recurringRuleLastExistingDate(r) ?? r.endDate,
                        }),
                        tone: 'warning',
                      }
                    : { label: t('recurring.statusEnded'), tone: 'neutral' }
                  : activeToday
                    ? { label: t('recurring.ruleNoEnd'), tone: 'neutral' }
                    : { label: t('recurring.statusNotStarted'), tone: 'neutral' };
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
                      {canEndToday ? (
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
              const spreadTotal = spreadTotalOf(m);
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
                // カードそのものをタップ = 編集。手で登録した item は継続コスト資産シート、
                // ルール由来（保存済み・未起票を問わず）は由来のルールのシートを開く。
                <div
                  className={`card card--pad${ending ? ' card--ending' : ''}`}
                  key={m.id}
                  data-ui={UI.allocations.item}
                  data-ending={ending ? 'true' : undefined}
                  data-derived-rule={fromRuleItem ? originRule?.id : undefined}
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
                    <span>{m.name}</span>
                    <span className="row-trailing">
                      <span className="list__amount">
                        <Money amount={m.amount} currency={currency} />
                      </span>
                      {fromRuleItem /* ルール由来 item は読み取り専用: 終了も削除も出さない
                           （導出カードは実在しないので元から対象が無い。保存済み ccr- も
                           「生まれたものへの個別操作は不可」＝調整は由来ルール側で行う）。
                           ボタンの代わりに由来を名乗るチップを同じ位置へ置く（v13.2:
                           縦揃えを崩さず「なぜボタンが無いか」も読める）。 */ ? (
                        <span className="tag tag--teal">{t('monthlyCost.fromRule')}</span>
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
                    <span className="muted">{t('ccItem.remainingValue')}</span>
                    <span>
                      <Money amount={remainingValue(m, asOf, spreadTotal)} currency={currency} />
                    </span>
                  </div>
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
                </div>
              );
            })}
          </div>
        </>
      )}

      {/*
       * 支払用負債（v13.4 ④ で資金繰りから移設）。行の設計図はルール行と同じで、
       * 左 = 名前と予定 / 右列 = 上段 残高・下段 操作（返済を登録）。行そのものはタップ対象に
       * しない（この行の「編集」= 返済予定の登録で、それが下段のボタンそのもの）。
       * 検索で 0 件になったセクションは丸ごと出さない（他セクションと同じ規則）。
       */}
      {shownLiabilities.length === 0 ? null : (
        <>
          <p className="section-label" style={{ marginTop: 'var(--space-3)' }}>
            {t('repay.sectionTitle')}
          </p>
          <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
            {t('repay.sectionIntro')}
          </p>
          <ul
            className="card list"
            style={{ marginBottom: 'var(--space-4)' }}
            data-ui={UI.allocations.liabilityList}
          >
            {shownLiabilities.map((l) => (
              <li
                key={l.id}
                ref={focusedLiabilityId === l.id ? focusedLiabilityRef : undefined}
                data-account-id={l.id}
              >
                <div className="list__item" data-ui={UI.allocations.liabilityRow}>
                  <div className="list__main">
                    <div className="list__title">{l.name}</div>
                    {l.account.repaymentAccountId !== undefined &&
                    l.account.repaymentDay !== undefined ? (
                      <div className="list__sub">
                        {t('repay.settingsLine', {
                          account: name(l.account.repaymentAccountId),
                          day: l.account.repaymentDay,
                        })}
                      </div>
                    ) : null}
                    {l.count > 0 ? (
                      <div className="list__sub">
                        {t('repay.nextDue')}: {l.nextDue ?? '—'}・
                        {t('repay.installmentsLeft', { count: l.count })}・{t('repay.balance')}{' '}
                        <Money amount={l.remaining} currency={currency} />
                      </div>
                    ) : (
                      <div className="list__sub">{t('repay.noPlanHint')}</div>
                    )}
                  </div>
                  {/* 右列 = 上段 残高 / 下段 動詞（tonal・高さは .btn の var(--tap)）。 */}
                  <div className="row-trailing">
                    <span className="list__amount">
                      {/* 負債残高は専用トークンの色（C-2）。絶対値表示のままで符号は付けない。 */}
                      <Money amount={l.balance} currency={currency} tone="liability" />
                    </span>
                    <button
                      type="button"
                      className="btn btn--tonal"
                      onClick={() => setRepayFor({ account: l.account, balance: l.balance })}
                      aria-label={`${t('repay.add')}: ${l.name}`}
                      data-ui={UI.allocations.repayAdd}
                    >
                      {t('repay.add')}
                    </button>
                  </div>
                </div>
                {/* 展開 = 登録済みの返済（基準日より後の保存仕訳・借方 = この負債）。タップで編集。 */}
                {l.repayments.length > 0 ? (
                  <div style={{ padding: '0 var(--space-4) var(--space-3)' }}>
                    <button
                      type="button"
                      className="collapse-toggle"
                      aria-expanded={openRepayments.has(l.id)}
                      onClick={() => toggleRepayments(l.id)}
                      data-ui={UI.allocations.repaymentsToggle}
                    >
                      <Icon name={openRepayments.has(l.id) ? 'expand' : 'chevronRight'} size={16} />
                      {t('repay.registered')}
                    </button>
                    {openRepayments.has(l.id) ? (
                      <ul className="list" data-ui={UI.allocations.repaymentsList}>
                        {l.repayments.map((e) => (
                          <li key={e.id}>
                            <button
                              type="button"
                              className="list__row-btn"
                              onClick={() => onEditEntry(e)}
                              aria-label={`${t('common.edit')}: ${e.date} ${e.description}`}
                              data-ui={UI.allocations.repaymentRow}
                            >
                              <span>{e.date}</span>
                              <span className="list__amount">
                                <Money amount={repaymentEntryAmount(e, l.id)} currency={currency} />
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      {repayFor ? (
        <RepaymentScheduleSheet
          account={repayFor.account}
          balance={repayFor.balance}
          onClose={() => setRepayFor(null)}
        />
      ) : null}

      {itemSheet ? (
        <ContinuousCostItemSheet
          {...(itemSheet.existing !== undefined ? { existing: itemSheet.existing } : {})}
          {...(itemSheet.existing !== undefined
            ? { purchaseEntry: purchaseEntryOf(itemSheet.existing) }
            : {})}
          onOpenPurchase={onEditEntry}
          onClose={() => setItemSheet(null)}
        />
      ) : null}

      {archiving ? (
        <MonthlyCostArchiveSheet
          item={archiving}
          spreadTotal={spreadTotalOf(archiving)}
          onClose={() => setArchiving(null)}
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

/** 統一追加フローの2択: くり返し記帳（ルール） / 継続コスト資産の持ち込み。 */
type AddPick = 'rule' | 'asset';

const ADD_CHOICES: { pick: AddPick; labelKey: MessageKey }[] = [
  { pick: 'rule', labelKey: 'monthly.pick.rule' },
  { pick: 'asset', labelKey: 'monthly.pick.asset' },
];

/** 「追加」の種別選択シート（種別の選択はそれぞれのシート内に一本化）。 */
function AddChooserSheet({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (pick: AddPick) => void;
}) {
  return (
    <Modal title={t('monthly.add')} onClose={onClose} dataUi={UI.allocations.addChooser}>
      <div className="stack">
        {ADD_CHOICES.map((c) => (
          <button
            key={c.pick}
            type="button"
            className="list__row-btn"
            onClick={() => onPick(c.pick)}
            data-ui={`${UI.allocations.addChooser}.${c.pick}`}
          >
            <span className="list__row-btn__label" style={{ fontWeight: 600 }}>
              {t(c.labelKey)}
            </span>
            <Icon name="chevronRight" size={16} />
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** 一覧で導出表示する種別。保存フィールドではない。 */
type SheetKind = RecurringKind | 'manual';

/**
 * ルールの表示・編集用の種別（保存しない）。利用者が指定した論理的な行き先と
 * 源泉の role から導出する（費用ルールの保存上の借方=内部台帳は判定に使わない）。
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

/**
 * 基準日入力から保存する dayOfMonth を決める（submit から移動・挙動は不変）。
 * 日付欄は「元の dayOfMonth をその月へクランプした結果」を表示している。表示どおりのまま
 * なら日を触っていない＝元の値を保つ（2 月のルールを開いて保存しただけで 31 → 28 に
 * 落ち、以後の起票日がずれるのを防ぐ）。日を変えたときだけ入力値を採用する。
 * 新規（existing なし）は入力値そのもの。保存とプレビューが同じ経路でこれを使う。
 */
function resolveRuleDayOfMonth(firstPostingDate: string, existing?: RecurringRule): number {
  const day = Number.parseInt(firstPostingDate.slice(8, 10), 10);
  return existing !== undefined &&
    clampDayToMonth(monthOf(firstPostingDate), existing.dayOfMonth).slice(8, 10) ===
      firstPostingDate.slice(8, 10)
    ? existing.dayOfMonth
    : day;
}

/**
 * 定期ルールの追加・編集シート。周期（everyMonths）付き。
 * 独自の種別 UI は持たず、簿記編集と同じく貸方・借方を直接指定する。
 * 継続コスト台帳を経由して月割りするかは明示トグル（行き先 role は既定の提案だけに使う）。
 */
function RecurringRuleSheet({
  existing,
  onClose,
}: {
  existing?: RecurringRule;
  onClose: () => void;
}) {
  const { ledger, createRecurringRule, saveRecurringRule, removeRecurringRule } = useLedger();
  const accounts = sortAccounts(ledger?.accounts ?? []);
  const currency = ledger?.settings.currency ?? '';

  const initialFromGroups = groupedAccountsByRole(
    accounts,
    [...RECURRING_POSTABLE_ROLES],
    existing?.creditAccountId,
  );
  const firstFromId = initialFromGroups.flatMap((group) => group.accounts)[0]?.id ?? '';
  const [creditAccountId, setCreditAccountId] = useState(existing?.creditAccountId ?? firstFromId);
  // 正規化済みの月割りルールでも内部台帳ではなく、利用者が指定した行き先を見せる。
  const existingDebit = existing ? recurringDestinationAccountId(existing) : undefined;
  const initialToGroups = groupedAccountsByRole(
    accounts,
    [...RECURRING_POSTABLE_ROLES],
    existingDebit,
  );
  const firstToId =
    initialToGroups
      .flatMap((group) => group.accounts)
      .find((account) => account.id !== creditAccountId)?.id ?? '';
  const [debitAccountId, setDebitAccountId] = useState(existingDebit ?? firstToId);
  const fromGroups = groupedAccountsByRole(
    accounts,
    [...RECURRING_POSTABLE_ROLES],
    creditAccountId,
  );
  // 行き先は源泉と同一科目を除く（振替の 預金→預金 を防ぐ）。
  const toGroups = groupedAccountsByRole(accounts, [...RECURRING_POSTABLE_ROLES], debitAccountId)
    .map((group) => ({
      ...group,
      accounts: group.accounts.filter((account) => account.id !== creditAccountId),
    }))
    .filter((group) => group.accounts.length > 0);

  const [name, setName] = useState(existing?.name ?? '');
  const fractionDigits = useMoneyDigits();
  const initialAmountText =
    existing !== undefined ? formatMinorForInput(existing.amount, fractionDigits) : '';
  const [amountText, setAmountText] = useState(initialAmountText);
  // 変更判定はフラグではなく値（初期表示と同じ文字列に戻れば無変更 = 保存済み minor を保持）。
  const amountDirty = amountText !== initialAmountText;
  const [everyText, setEveryText] = useState(
    existing !== undefined ? String(existing.everyMonths) : '1',
  );
  const [firstPostingDate, setFirstPostingDate] = useState(() =>
    existing ? clampDayToMonth(existing.startMonth, existing.dayOfMonth) : todayLocal(),
  );
  const [startDate, setStartDate] = useState(
    existing ? effectiveRecurringRuleStartDate(existing) : todayLocal(),
  );
  // 新規作成は存在期間を出さない（開始 = 初回の起票日で自動・v13.1 その4）。
  const effectiveStartDate = existing ? startDate : firstPostingDate;
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  // 存在期間（開始日・終了日）は詳細の折りたたみへ（編集時のみ・既定は閉じる）。
  const [showDetails, setShowDetails] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pendingAmountChange, setPendingAmountChange] = useState<{
    rule: RecurringRule;
    effectiveDate: string;
  } | null>(null);
  const [amountChangeError, setAmountChangeError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  // 破壊的操作は編集シート最下部（動詞体系 v13.1）。確認ダイアログとの 2 段防御は従来どおり。
  const [pendingDelete, setPendingDelete] = useState(false);
  // 終了の Undo。削除と違い取り消し可能（解除 ⇄ 終了）だが、状態を変えるので確認は挟む。
  const [pendingClearEnd, setPendingClearEnd] = useState(false);
  // 保存済みルールが今日までに立てている起票数。編集の引き直し予告と、カスケード削除の
  // 確認の両方が同じ数を使う（v13: 数える対象 = 今日までに導出される起票）。
  const pastPostings = useMemo(
    () =>
      existing !== undefined
        ? deriveRecurringOutputs([existing], ledger?.accounts ?? [], todayLocal()).entries.length
        : 0,
    [existing, ledger],
  );
  const canSplitAtEffectiveDate =
    pendingAmountChange !== null &&
    existing !== undefined &&
    pendingAmountChange.effectiveDate > effectiveRecurringRuleStartDate(existing) &&
    recurringRuleExistsAt(existing, pendingAmountChange.effectiveDate) &&
    (pendingAmountChange.rule.endDate === undefined ||
      pendingAmountChange.effectiveDate < pendingAmountChange.rule.endDate);

  // 起票プレビュー: いまのフォーム値で最初に起票される実際の日付（保存はしない・読み取り専用）。
  // 周期 >= 2 では基準日の年月が位相を決める（recurringPostingsDue が startMonth 基点で刻む）
  // ため、周期テンプレ文言ではなく日付そのものを出す＝基準日を変えると位相が動くことが画面に
  // 出る。保存値と同じ resolveRuleDayOfMonth / firstRecurringPostingDate を通す。
  // どれかの入力が不正な間は行ごと出さない（fail-closed）。
  const previewEvery = everyText === '' ? Number.NaN : Number.parseInt(everyText, 10);
  const firstPosting =
    Number.isInteger(previewEvery) &&
    previewEvery >= 1 &&
    previewEvery <= CATCH_UP_HARD_CAP_MONTHS &&
    isValidIsoDate(firstPostingDate) &&
    isValidIsoDate(effectiveStartDate) &&
    (endDate === '' || isValidIsoDate(endDate))
      ? firstRecurringPostingDate({
          startMonth: monthOf(firstPostingDate),
          dayOfMonth: resolveRuleDayOfMonth(firstPostingDate, existing),
          everyMonths: previewEvery,
          startDate: effectiveStartDate,
          ...(endDate !== '' ? { endDate } : {}),
        })
      : null;

  // 起票プレビューの読み上げ文。マウント時は '' で、effect が最初の値を入れることで
  // 「変化」として通知される（live region の制約）。値が無くなったときも明示的に伝える。
  const [firstPostingAnnounce, setFirstPostingAnnounce] = useState('');
  useEffect(() => {
    // live region は「マウント後の変化」だけが読み上げられるため、意図的に effect で
    // setState する（初期値を JSX に直接書くと初回が通知されない）。1 値の更新のみで
    // 連鎖レンダーは起きない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFirstPostingAnnounce(
      firstPosting !== null
        ? t('recurring.firstPostingStatus', { date: firstPosting })
        : t('recurring.firstPostingNone'),
    );
  }, [firstPosting]);

  async function persistExisting(
    rule: RecurringRule,
    options?: {
      amountChangeMode?: 'retroactive' | 'split';
      effectiveDate?: string;
    },
  ) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    setAmountChangeError(undefined);
    try {
      await saveRecurringRule(rule, options);
      onClose();
    } catch (e) {
      const message = errorText(e);
      if (pendingAmountChange) setAmountChangeError(message);
      else setError(message);
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function submit() {
    if (submittingRef.current) return;
    const amount =
      existing !== undefined && !amountDirty
        ? existing.amount
        : (parseAmountToMinor(amountText) ?? 0);
    if (!Number.isInteger(amount) || amount < 1) {
      setError(t('error.common.amountInvalid'));
      return;
    }
    const everyMonths = everyText === '' ? 0 : Number.parseInt(everyText, 10);
    // 上限は保存境界・schema と同じ（配分月数の上限）。画面でも先に弾いて理由を示す。
    if (
      !Number.isInteger(everyMonths) ||
      everyMonths < 1 ||
      everyMonths > CATCH_UP_HARD_CAP_MONTHS
    ) {
      setError(t('error.recurring.everyMonthsInvalid'));
      return;
    }
    if (!isValidIsoDate(effectiveStartDate)) {
      setError(t('error.recurring.periodInvalid'));
      return;
    }
    if (endDate !== '' && (!isValidIsoDate(endDate) || endDate <= effectiveStartDate)) {
      setError(t('error.recurring.periodInvalid'));
      return;
    }
    const day = Number.parseInt(firstPostingDate.slice(8, 10), 10);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      setError(t('error.recurring.dayOfMonthInvalid'));
      return;
    }
    const startMonth = monthOf(firstPostingDate);
    // 31日ルールの往復規則（resolveRuleDayOfMonth）。保存とプレビューで同じ関数を通す。
    const dayOfMonth = resolveRuleDayOfMonth(firstPostingDate, existing);
    setError(undefined);
    try {
      if (existing) {
        const next: RecurringRule = {
          ...existing,
          name: name.trim(),
          amount,
          dayOfMonth,
          everyMonths,
          debitAccountId,
          creditAccountId,
          startMonth,
          startDate,
          updatedAt: nowIso(),
        };
        if (endDate !== '') next.endDate = endDate;
        else delete next.endDate;
        // 計上先をそのまま保存形へ写す（debitAccountId は論理的な行き先のまま渡し、
        // 借方 = 台帳への正規化は保存境界が行う）。
        next.spreadExpenseAccountId = debitAccountId;
        if (amount !== existing.amount) {
          setPendingAmountChange({ rule: next, effectiveDate: todayLocal() });
          setAmountChangeError(undefined);
          return;
        }
        await persistExisting(next);
        return;
      } else {
        submittingRef.current = true;
        setSubmitting(true);
        await createRecurringRule({
          name: name.trim(),
          amount,
          dayOfMonth,
          everyMonths,
          debitAccountId,
          creditAccountId,
          startMonth,
          // 新規は開始 = 初回の起票日で自動（存在期間の欄を出さない・v13.1 その4）。
          startDate: effectiveStartDate,
          ...(endDate !== '' ? { endDate } : {}),
        });
      }
      onClose();
    } catch (e) {
      setError(errorText(e));
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <>
      <Modal
        title={existing ? t('recurring.editTitle') : t('recurring.createTitle')}
        onClose={onClose}
        dismissMode="if-clean"
        dataUi={UI.allocations.recurringSheet}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={submit}
              disabled={
                submitting ||
                name.trim() === '' ||
                amountText === '' ||
                everyText === '' ||
                firstPostingDate === '' ||
                (existing !== undefined && startDate === '') ||
                creditAccountId === '' ||
                debitAccountId === ''
              }
              data-ui={UI.allocations.recurringSave}
            >
              {t('common.save')}
            </button>
          </>
        }
      >
        <div className="stack">
          <p className="field__hint">{t('recurring.sectionIntro')}</p>
          {error ? (
            <div className="field__error" role="alert">
              <Icon name="alert" size={14} />
              {error}
            </div>
          ) : null}
          {/* 並び（v13.1 その4・作者確定）: 初回の起票日 → 周期 → 摘要 → 金額 →
              貸方（支払い元）→ 借方（計上先）→ プレビュー → 詳細（存在期間・編集のみ）。 */}
          <TextInput
            label={t('recurring.firstPostingDate')}
            type="date"
            required
            value={firstPostingDate}
            onChange={setFirstPostingDate}
            hint={t('recurring.firstPostingDateHint')}
            dataUi={UI.allocations.recurringFirstPostingDate}
          />
          <TextInput
            label={t('recurring.intervalMonths')}
            required
            inputMode="numeric"
            value={everyText}
            onChange={(v) => setEveryText(v.replace(/[^\d]/g, ''))}
            dataUi={UI.allocations.recurringEvery}
          />
          <TextInput
            label={t('recurring.name')}
            required
            value={name}
            onChange={setName}
            hint={t('recurring.nameHint')}
            dataUi={UI.allocations.recurringName}
          />
          <TextInput
            label={t('recurring.amount')}
            required
            inputMode={fractionDigits === 0 ? 'numeric' : 'decimal'}
            value={amountText}
            onChange={(v) => {
              setAmountText(sanitizeAmountText(v, fractionDigits, amountText));
            }}
            hint={t('recurring.amountHint')}
            dataUi={UI.allocations.recurringAmount}
          />
          {/* ホームの簿記編集と同じ「貸方 → 借方」の外枠 + flat チップ（作者決定 2026-08-12:
              グループ見出し・色分けは不要・ホームへ揃える）。候補構築は定期ルールの許可 role
              （RECURRING_POSTABLE_ROLES）のまま変えない。 */}
          <FlowField
            dataUi={UI.allocations.recurringFlow}
            source={
              <AccountPicker
                flat
                label={t('recurring.from.manual')}
                required
                value={creditAccountId}
                onChange={(id) => {
                  setCreditAccountId(id);
                  if (id === debitAccountId) setDebitAccountId('');
                }}
                groups={fromGroups}
                dataUi={UI.allocations.recurringFrom}
              />
            }
            destination={
              <AccountPicker
                flat
                // 全ルールが台帳経由なので行き先の意味は常に「計上先」。
                label={t('monthlyCost.expenseCategory')}
                required
                value={debitAccountId}
                onChange={setDebitAccountId}
                groups={toGroups}
                hint={t('recurring.manualHint')}
                dataUi={UI.allocations.recurringTo}
              />
            }
          />
          {/* 視覚行は値があるときだけ（空の枠を残さない）。読み上げは下の常設 status が担う。 */}
          {firstPosting !== null ? (
            <div className="kv" data-ui={UI.allocations.recurringFirstPosting}>
              <span className="muted">{t('recurring.firstPosting')}</span>
              <span>{firstPosting}</span>
            </div>
          ) : null}
          {/* 編集 = 全期間の引き直し（宣言モデル）。過去の起票数を添えて「切替」との
              使い分けが学べるようにする（実ユーズレビュー 2026-08-16）。 */}
          {existing !== undefined && pastPostings > 0 ? (
            <p
              className="field__hint"
              data-ui={UI.allocations.recurringEditRetroactiveNote}
              role="note"
            >
              {t('recurring.editRetroactiveNote', { count: pastPostings })}
            </p>
          ) : null}
          {/* live region は「内容が変わる前から存在」して初めて読み上げられるため、
              空でマウントし effect で流し込む（初期値も 1 回の変化として通知される）。
              値が消えたときも「ありません」を明示的に通知する。 */}
          <p className="sr-only" role="status" data-ui={UI.allocations.recurringFirstPostingStatus}>
            {firstPostingAnnounce}
          </p>
          {/* 存在期間（開始日・終了日）は詳細の折りたたみへ。新規作成では出さない
              （開始 = 初回の起票日で自動・v13.1 その4）。 */}
          {existing ? (
            <>
              <button
                type="button"
                className="collapse-toggle"
                aria-expanded={showDetails}
                onClick={() => setShowDetails((v) => !v)}
                data-ui={UI.allocations.recurringDetailsToggle}
              >
                <Icon name={showDetails ? 'expand' : 'chevronRight'} size={16} />
                {t('recurring.detailsToggle')}
              </button>
              {showDetails ? (
                <div className="stack">
                  <TextInput
                    label={t('recurring.ruleStartDate')}
                    type="date"
                    required
                    value={startDate}
                    onChange={setStartDate}
                    hint={t('recurring.ruleStartDateHint')}
                    dataUi={UI.allocations.recurringStartDate}
                  />
                  <TextInput
                    label={t('recurring.ruleEndDate')}
                    type="date"
                    value={endDate}
                    onChange={setEndDate}
                    hint={t('recurring.ruleEndDateHint')}
                    dataUi={UI.allocations.recurringEndDate}
                  />
                  {/* iOS の date input には値を空へ戻す手段が無い（継続コスト編集シートと同じ理由の明示ボタン）。 */}
                  {endDate !== '' ? (
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        style={{ minHeight: 'var(--tap)' }}
                        onClick={() => setEndDate('')}
                        data-ui={UI.allocations.recurringEndDateClear}
                      >
                        {t('ccItem.endDateClear')}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          {/* 破壊的なほど下（動詞体系 v13.1・HIG の連絡先・カレンダー方式）:
              [終了日を解除（終了済みのみ）] → [このルールを削除…]。 */}
          {existing ? (
            <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
              {existing.endDate !== undefined ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  style={{ minHeight: 'var(--tap)' }}
                  disabled={submitting}
                  onClick={() => setPendingClearEnd(true)}
                  data-ui={UI.allocations.recurringClearEndDate}
                >
                  {t('recurring.clearEndDate')}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--danger"
                style={{ minHeight: 'var(--tap)' }}
                disabled={submitting}
                onClick={() => setPendingDelete(true)}
                data-ui={UI.allocations.recurringDelete}
              >
                {t('recurring.deleteAction')}
              </button>
              <p className="field__hint">{t('recurring.deleteDangerHint')}</p>
            </div>
          ) : null}
        </div>
      </Modal>
      {pendingClearEnd && existing ? (
        <ConfirmDialog
          title={t('recurring.clearEndDateConfirmTitle')}
          body={t('recurring.clearEndDateConfirmBody', { name: existing.name })}
          confirmLabel={t('recurring.clearEndDate')}
          dataUi={UI.allocations.recurringClearEndDateConfirm}
          onCancel={() => setPendingClearEnd(false)}
          onConfirm={async () => {
            setPendingClearEnd(false);
            // 解除は保存済みルールに対する動詞（フォームの未保存編集は含めない）。
            const next: RecurringRule = { ...existing, updatedAt: nowIso() };
            delete next.endDate;
            await persistExisting(next);
          }}
        />
      ) : null}
      {pendingDelete && existing ? (
        <ConfirmDialog
          title={t('recurring.deleteConfirmTitle')}
          /* カスケード削除（作者決定 2026-08-15）: 積み木の下（ルール）が消えれば上（起票された
             仕訳・持ち物）も消える。何回ぶん消えるかを数で名乗る（0 件なら別文言）。 */
          body={
            pastPostings > 0
              ? t('recurring.deleteConfirmBody', { name: existing.name, count: pastPostings })
              : t('recurring.deleteConfirmNoPostingsBody', { name: existing.name })
          }
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingDelete(false)}
          onConfirm={async () => {
            setPendingDelete(false);
            await removeRecurringRule(existing.id).catch(() => undefined);
            onClose();
          }}
        />
      ) : null}
      {pendingAmountChange && existing ? (
        <Modal
          title={t('recurring.amountChangeTitle')}
          dismissMode="never"
          onClose={() => {
            if (submitting) return;
            setPendingAmountChange(null);
            setAmountChangeError(undefined);
          }}
          dataUi={UI.allocations.recurringAmountChangeDialog}
          footer={
            <button
              type="button"
              className="btn btn--ghost"
              disabled={submitting}
              onClick={() => {
                setPendingAmountChange(null);
                setAmountChangeError(undefined);
              }}
              data-ui={UI.allocations.recurringAmountChangeCancel}
            >
              {t('recurring.amountChangeBack')}
            </button>
          }
        >
          <div className="stack">
            <p>
              {t(
                canSplitAtEffectiveDate
                  ? 'recurring.amountChangeBody'
                  : 'recurring.amountChangeWholeOnlyBody',
                { date: pendingAmountChange.effectiveDate },
              )}
            </p>
            <div className="kv">
              <span className="muted">{t('recurring.amount')}</span>
              <span>
                <Money amount={existing.amount} currency={currency} /> →{' '}
                <Money amount={pendingAmountChange.rule.amount} currency={currency} />
              </span>
            </div>
            {amountChangeError ? (
              <div className="field__error" role="alert">
                <Icon name="alert" size={14} />
                {amountChangeError}
              </div>
            ) : null}
            <button
              type="button"
              className="list__row-btn"
              disabled={submitting}
              onClick={() =>
                persistExisting(pendingAmountChange.rule, {
                  amountChangeMode: 'retroactive',
                })
              }
              data-ui={UI.allocations.recurringAmountChangeAll}
            >
              <div className="list__main">
                <div className="list__title">{t('recurring.amountChangeAll')}</div>
                <div className="list__sub">{t('recurring.amountChangeAllHint')}</div>
              </div>
              <Icon name="chevronRight" size={16} />
            </button>
            {canSplitAtEffectiveDate ? (
              <button
                type="button"
                className="list__row-btn"
                disabled={submitting}
                onClick={() =>
                  persistExisting(pendingAmountChange.rule, {
                    amountChangeMode: 'split',
                    effectiveDate: pendingAmountChange.effectiveDate,
                  })
                }
                data-ui={UI.allocations.recurringAmountChangeFromToday}
              >
                <div className="list__main">
                  <div className="list__title">
                    {t('recurring.amountChangeFromToday', {
                      date: pendingAmountChange.effectiveDate,
                    })}
                  </div>
                  <div className="list__sub">
                    {t('recurring.amountChangeFromTodayHint', {
                      date: pendingAmountChange.effectiveDate,
                    })}
                  </div>
                </div>
                <Icon name="chevronRight" size={16} />
              </button>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * 継続コスト資産シート（登録＝編集の 1 コンポーネント）。
 *  - 新規 = 持ち込み登録: 金額は購入額。過去日で普通に登録できる（制約なし）。貸方は初期残高。
 *  - 編集 = 名前・金額・終了日・費用の行き先のみ。開始日は購入の仕訳の日付のミラーなので
 *    読み取り専用（タップで購入の仕訳へ）。
 *  - 終了日は空でよい（空なら費用の割り振りをしない）。
 */
function ContinuousCostItemSheet({
  existing,
  purchaseEntry,
  onOpenPurchase,
  onClose,
}: {
  existing?: MonthlyCostItem;
  purchaseEntry?: JournalEntry | undefined;
  onOpenPurchase: (entry: JournalEntry) => void;
  onClose: () => void;
}) {
  const { ledger, createContinuousCost, saveMonthlyCost, removeMonthlyCost } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const monthlyAllocationOptions = monthlyAllocationAccountOptions(
    accounts,
    existing?.expenseAccountId,
  );
  // 破壊的操作は編集シート最下部（動詞体系 v13.1）。確認ダイアログとの 2 段防御は従来どおり。
  const [pendingDelete, setPendingDelete] = useState(false);

  const [name, setName] = useState(existing?.name ?? '');
  const fractionDigits = useMoneyDigits();
  const initialAmountText =
    existing !== undefined ? formatMinorForInput(existing.amount, fractionDigits) : '';
  const [amountText, setAmountText] = useState(initialAmountText);
  // 変更判定はフラグではなく値（初期表示と同じ文字列に戻れば無変更 = 保存済み minor を保持）。
  const amountDirty = amountText !== initialAmountText;
  const [startDate, setStartDate] = useState(existing?.startDate ?? todayLocal());
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  // 費用の行き先の既定値は「前回選んだもの」（連続登録の切り替え手間を減らす）。
  const [expenseAccountId, setExpenseAccountId] = useState(() => {
    if (existing) return existing.expenseAccountId;
    const last = lastExpenseCategoryId();
    if (last && monthlyAllocationOptions.some((o) => o.value === last)) return last;
    return defaultMonthlyAllocationAccountId(accounts);
  });
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  // 過去から再計算される項目の変更予告（破壊的操作の予告なので削らない）。
  const effectiveAmount =
    existing !== undefined && !amountDirty
      ? existing.amount
      : (parseAmountToMinor(amountText) ?? 0);
  const pastFieldsChanged =
    existing !== undefined &&
    (effectiveAmount !== existing.amount ||
      endDate !== (existing.endDate ?? '') ||
      expenseAccountId !== existing.expenseAccountId);

  async function submit() {
    if (submitting) return;
    const amount = effectiveAmount;
    if (!Number.isInteger(amount) || amount < 1) {
      setError(t('error.common.amountInvalid'));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      if (existing) {
        const next: MonthlyCostItem = {
          ...existing,
          name: name.trim(),
          amount,
          expenseAccountId,
          updatedAt: nowIso(),
        };
        if (endDate.trim() === '') delete next.endDate;
        else next.endDate = endDate.trim();
        await saveMonthlyCost(next);
      } else {
        await createContinuousCost({
          name: name.trim(),
          amount,
          startDate,
          ...(endDate.trim() !== '' ? { endDate: endDate.trim() } : {}),
          expenseAccountId,
        });
      }
      rememberExpenseCategoryId(expenseAccountId);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
    <>
      <Modal
        title={existing ? t('monthlyCost.editTitle') : t('monthly.pick.asset')}
        onClose={onClose}
        dismissMode="if-clean"
        dataUi={UI.allocations.editDialog}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={submit}
              disabled={submitting || name.trim() === '' || amountText === '' || startDate === ''}
              data-ui={UI.allocations.editSave}
            >
              {t('common.save')}
            </button>
          </>
        }
      >
        <div className="stack">
          {error ? (
            <div className="field__error" role="alert">
              <Icon name="alert" size={14} />
              {error}
            </div>
          ) : null}
          {pastFieldsChanged ? (
            <div
              className="field__warning"
              role="status"
              data-ui={UI.allocations.editImpactWarning}
            >
              <Icon name="alert" size={14} />
              {t('monthlyCost.pastRecalcWarning')}
            </div>
          ) : null}
          <TextInput
            label={t('monthlyCost.name')}
            required
            value={name}
            onChange={setName}
            dataUi={UI.allocations.editName}
          />
          <TextInput
            label={t('monthlyCost.amount')}
            required
            inputMode={fractionDigits === 0 ? 'numeric' : 'decimal'}
            value={amountText}
            onChange={(v) => {
              setAmountText(sanitizeAmountText(v, fractionDigits, amountText));
            }}
            dataUi={UI.allocations.editAmount}
          />
          {existing ? (
            <>
              {/* 開始日 = 購入の仕訳の日付。変えるときは仕訳側（タップで開く）。 */}
              <div className="kv" data-ui={UI.allocations.editStartDate}>
                <span className="muted">{t('ccItem.startDate')}</span>
                <span>{existing.startDate}</span>
              </div>
              {purchaseEntry ? (
                <button
                  type="button"
                  className="collapse-toggle"
                  onClick={() => {
                    onClose();
                    onOpenPurchase(purchaseEntry);
                  }}
                  data-ui={UI.allocations.editOpenPurchase}
                >
                  <Icon name="chevronRight" size={16} />
                  {t('ccItem.openPurchase')}
                </button>
              ) : null}
            </>
          ) : (
            <TextInput
              label={t('ccItem.startDate')}
              type="date"
              required
              value={startDate}
              onChange={setStartDate}
              dataUi={UI.allocations.editStartDate}
            />
          )}
          <TextInput
            label={t('ccItem.endDate')}
            type="date"
            value={endDate}
            onChange={setEndDate}
            dataUi={UI.allocations.editEndDate}
          />
          <div className="row-actions" data-ui={UI.allocations.editQuickSpan}>
            {[1, 3, 5].map((years) => (
              <button
                key={years}
                type="button"
                className="btn btn--ghost"
                style={{ minHeight: 'var(--tap)' }}
                onClick={() => setEndDate(quickSpanEndDate(startDate, years))}
              >
                {t('ccItem.quickSpan', { years })}
              </button>
            ))}
            {/* 空で保存 = 終了日の解除は元から許可されている（保存側の仕様）。
              ただし iOS の date input には値を空へ戻す手段が無いため、明示ボタンで到達させる。 */}
            {endDate !== '' ? (
              <button
                type="button"
                className="btn btn--ghost"
                style={{ minHeight: 'var(--tap)' }}
                onClick={() => setEndDate('')}
                data-ui={UI.allocations.editEndDateClear}
              >
                {t('ccItem.endDateClear')}
              </button>
            ) : null}
          </div>
          <SelectInput
            label={t('monthlyCost.expenseCategory')}
            value={expenseAccountId}
            onChange={setExpenseAccountId}
            options={monthlyAllocationOptions}
            dataUi={UI.allocations.editExpense}
          />
          {/* 破壊的なほど下（動詞体系 v13.1）。行アクションには削除を置かない。 */}
          {existing ? (
            <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
              <button
                type="button"
                className="btn btn--danger"
                style={{ minHeight: 'var(--tap)' }}
                disabled={submitting}
                onClick={() => setPendingDelete(true)}
                data-ui={UI.allocations.editDelete}
              >
                {t('monthlyCost.deleteAction')}
              </button>
              <p className="field__hint">{t('monthlyCost.deleteDangerHint')}</p>
            </div>
          ) : null}
        </div>
      </Modal>
      {pendingDelete && existing ? (
        <ConfirmDialog
          title={t('monthlyCost.deleteConfirmTitle')}
          body={t('monthlyCost.deleteConfirmBody', { name: existing.name })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingDelete(false)}
          onConfirm={async () => {
            setPendingDelete(false);
            await removeMonthlyCost(existing.id).catch(() => undefined);
            onClose();
          }}
        />
      ) : null}
    </>
  );
}

/* ── ルールの切り替え・終了と、配分中 item の清算（v13） ── */

/**
 * splitFromRuleId で連結する系譜（connected component）のルール。
 * 保存境界（repository.lineageRuleIds）と同じ規則の読み取り版で、清算できる item の
 * 母集合を「同じ位置から伸びた線分たち」に限る（系譜外は保存側が fail-closed に弾く）。
 */
function lineageRules(rules: readonly RecurringRule[], ruleId: string): RecurringRule[] {
  const ids = new Set<string>([ruleId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const rule of rules) {
      if (ids.has(rule.id)) {
        if (rule.splitFromRuleId !== undefined && !ids.has(rule.splitFromRuleId)) {
          ids.add(rule.splitFromRuleId);
          grew = true;
        }
      } else if (rule.splitFromRuleId !== undefined && ids.has(rule.splitFromRuleId)) {
        ids.add(rule.id);
        grew = true;
      }
    }
  }
  return rules.filter((rule) => ids.has(rule.id));
}

/** 清算できる 1 件（導出 item + その日の残存価値と既定の回収額）。 */
interface SettlementCandidate {
  item: MonthlyCostItem;
  /** その item を導出した線分（系譜内のどれか）と起票月 = ccr-{ruleId}-{month}。 */
  ruleId: string;
  month: string;
  remaining: number;
  digits: FractionDigits;
  defaultRecoveryText: string;
}

/** 1 件ぶんの選択（意味論はアーカイブシートと同一）。 */
interface SettlementDraft {
  mode: 'keep' | 'end';
  recoveryText: string;
  recoveryAccountId: string;
  remainderMode: 'spread' | 'expense';
}

interface RecurringSettlementState {
  candidates: SettlementCandidate[];
  draftOf: (candidate: SettlementCandidate) => SettlementDraft;
  update: (candidate: SettlementCandidate, patch: Partial<SettlementDraft>) => void;
  /** switchRecurringRule へ渡す清算（「この日で終える」を選んだぶんだけ）。 */
  inputs: RecurringRuleSettlementInput[];
  /** 回収額 > 0 なのに回収先が未選択の行が無いか（保存ボタンの活性）。 */
  canSave: boolean;
}

function defaultSettlementDraft(candidate: SettlementCandidate): SettlementDraft {
  return {
    mode: 'keep',
    recoveryText: candidate.defaultRecoveryText,
    recoveryAccountId: '',
    remainderMode: 'spread',
  };
}

/**
 * 切り替えシート・終了シートが共有する清算 state（対象の導出と 0〜2 本の回収の組み立て）。
 *
 * 対象 = **この系譜が導出した配分中の item**（切り替え日の時点でまだ残存価値があり、
 * その日が期間の内側にあるもの）。「生まれた線は自分の寿命を持つ」ので、何も選ばなければ
 * それぞれの終了日まで走り切る（= settlements を 1 件も送らない）。
 */
function useRecurringSettlements(
  rule: RecurringRule,
  effectiveDate: string,
): RecurringSettlementState {
  const { ledger } = useLedger();
  const displayDigits = useMoneyDigits();
  const today = todayLocal();
  const dateValid = isValidIsoDate(effectiveDate);
  const recovered = useMemo(() => recoveredAmountsByItem(ledger?.journalEntries ?? []), [ledger]);

  const candidates = useMemo<SettlementCandidate[]>(() => {
    // 台帳を経由しないルールは item を生まない = 清算する対象がそもそも無い。
    if (rule.spreadExpenseAccountId === undefined || !dateValid) return [];
    const { items } = deriveRecurringOutputs(
      lineageRules(ledger?.recurringRules ?? [], rule.id),
      ledger?.accounts ?? [],
      today,
    );
    return items
      .filter(
        (item) =>
          item.startDate < effectiveDate &&
          (item.endDate === undefined || item.endDate > effectiveDate),
      )
      .flatMap((item) => {
        const origin = parseRuleItemId(item.id);
        if (origin === undefined) return [];
        const remaining = remainingValue(item, effectiveDate, computeSpreadTotal(item, recovered));
        // 残存価値が尽きている item は「終える」ことに意味が無い（作る仕訳も無い）。
        if (remaining <= 0) return [];
        // 表示桁 0 の設定でも、この欄だけは端数を隠さない（見えている値 = 保存される値）。
        const digits = Math.max(displayDigits, exactDigitsFor(remaining)) as FractionDigits;
        return [
          {
            item,
            ruleId: origin.ruleId,
            month: origin.month,
            remaining,
            digits,
            defaultRecoveryText: formatMinorForInput(remaining, digits),
          },
        ];
      })
      .sort((a, b) => (a.item.startDate < b.item.startDate ? -1 : 1));
  }, [ledger, rule, effectiveDate, dateValid, recovered, displayDigits, today]);

  const [drafts, setDrafts] = useState<Record<string, SettlementDraft>>({});
  // 回収額の既定は切り替え日に追従する。既定のままなら追従し、手で直してあればその値を
  // 尊重する（判定はフラグではなく値 = アーカイブシートと同じ流儀）。
  const autoRecoveryRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const pending = candidates.filter(
      (candidate) => autoRecoveryRef.current[candidate.item.id] !== candidate.defaultRecoveryText,
    );
    if (pending.length === 0) return;
    const previousAuto: Record<string, string | undefined> = {};
    for (const candidate of pending) {
      previousAuto[candidate.item.id] = autoRecoveryRef.current[candidate.item.id];
      autoRecoveryRef.current[candidate.item.id] = candidate.defaultRecoveryText;
    }
    setDrafts((current) => {
      const next = { ...current };
      let changed = false;
      for (const candidate of pending) {
        const draft = next[candidate.item.id];
        if (draft === undefined) continue; // まだ触られていない行は draftOf の既定が追従する。
        if (draft.recoveryText === previousAuto[candidate.item.id]) {
          next[candidate.item.id] = { ...draft, recoveryText: candidate.defaultRecoveryText };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [candidates]);

  const draftOf = (candidate: SettlementCandidate): SettlementDraft =>
    drafts[candidate.item.id] ?? defaultSettlementDraft(candidate);
  const update = (candidate: SettlementCandidate, patch: Partial<SettlementDraft>): void => {
    setDrafts((current) => ({
      ...current,
      [candidate.item.id]: {
        ...(current[candidate.item.id] ?? defaultSettlementDraft(candidate)),
        ...patch,
      },
    }));
  };

  const selected = candidates.filter((candidate) => draftOf(candidate).mode === 'end');
  const inputs: RecurringRuleSettlementInput[] = selected.map((candidate) => {
    const draft = draftOf(candidate);
    const amount = parseAmountToMinor(draft.recoveryText) ?? 0;
    const recoveries: { destinationAccountId: string; amount: number }[] = [];
    if (amount > 0) {
      recoveries.push({ destinationAccountId: draft.recoveryAccountId, amount });
    }
    // 第 2 の回収の振替（借方 = item の計上先 / 貸方 = 継続コスト台帳）。
    const rest = candidate.remaining - amount;
    if (rest > 0 && draft.remainderMode === 'expense') {
      recoveries.push({ destinationAccountId: candidate.item.expenseAccountId, amount: rest });
    }
    return {
      ruleId: candidate.ruleId,
      month: candidate.month,
      ...(recoveries.length > 0 ? { recoveries } : {}),
    };
  });
  const canSave = selected.every((candidate) => {
    const draft = draftOf(candidate);
    return (parseAmountToMinor(draft.recoveryText) ?? 0) === 0 || draft.recoveryAccountId !== '';
  });

  return { candidates, draftOf, update, inputs, canSave };
}

/**
 * 清算パネル（切り替えシート・終了シートで共通の表示）。
 * 「終える」を選んだ行だけアーカイブシートと同じ 3 点（回収額・回収先・残りの扱い）を出す。
 */
function RecurringSettlementPanel({
  state,
  effectiveDate,
}: {
  state: RecurringSettlementState;
  effectiveDate: string;
}) {
  const { ledger } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? '';
  if (state.candidates.length === 0) return null;
  return (
    <div className="stack" data-ui={UI.allocations.recurringSettlement}>
      <p className="section-label">{t('recurring.settlementTitle')}</p>
      <p className="field__hint">{t('recurring.settlementIntro')}</p>
      {state.candidates.map((candidate) => {
        const draft = state.draftOf(candidate);
        const recoveryAmount = parseAmountToMinor(draft.recoveryText) ?? 0;
        // 残り = 残存価値 − 回収額。負（超過回収）なら spreadTotal が負になり、過去に
        // わたる費用減として按分される＝「終了日に全額」は選べない。
        const rest = candidate.remaining - recoveryAmount;
        const remainderChoosable = rest > 0;
        const expenseAccountName =
          accounts.find((a) => a.id === candidate.item.expenseAccountId)?.name ??
          candidate.item.expenseAccountId;
        return (
          <div
            className="card card--pad"
            key={candidate.item.id}
            data-ui={UI.allocations.recurringSettlementItem}
            data-item-id={candidate.item.id}
          >
            <div className="list__title">{candidate.item.name}</div>
            <div className="kv">
              <span className="muted">{t('ccItem.period')}</span>
              <span>
                {candidate.item.startDate} 〜 {candidate.item.endDate ?? '—'}
              </span>
            </div>
            <div className="kv">
              <span className="muted">{t('ccItem.remainingValue')}</span>
              <span>{moneyText(candidate.remaining, currency, candidate.digits)}</span>
            </div>
            <div className="picker__chips" style={{ marginTop: 'var(--space-2)' }}>
              {(
                [
                  ['keep', 'recurring.settlementKeep', UI.allocations.recurringSettlementKeep],
                  ['end', 'recurring.settlementEnd', UI.allocations.recurringSettlementEnd],
                ] as const
              ).map(([mode, labelKey, dataUi]) => (
                <label className="chip" key={mode}>
                  <input
                    type="radio"
                    className="sr-only"
                    name={`rule-settlement-${candidate.item.id}`}
                    value={mode}
                    checked={draft.mode === mode}
                    onChange={() => state.update(candidate, { mode })}
                    data-ui={dataUi}
                  />
                  <span className="chip__check" aria-hidden="true">
                    <Icon name="check" size={14} />
                  </span>
                  <span className="chip__text">{t(labelKey)}</span>
                </label>
              ))}
            </div>
            {draft.mode === 'end' ? (
              <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
                <TextInput
                  label={t('ccItem.archiveRecovery')}
                  inputMode={candidate.digits === 0 ? 'numeric' : 'decimal'}
                  value={draft.recoveryText}
                  onChange={(v) =>
                    state.update(candidate, {
                      recoveryText: sanitizeAmountText(v, candidate.digits, draft.recoveryText),
                    })
                  }
                  hint={t('ccItem.archiveRecoveryHint')}
                  dataUi={UI.allocations.recurringSettlementRecoveryAmount}
                />
                {/* 回収額 0 = 作る仕訳が無い。回収先は出さない（選ばせて捨てない）。 */}
                {recoveryAmount > 0 ? (
                  <AccountPicker
                    label={t('ccItem.archiveRecoveryTo')}
                    required
                    value={draft.recoveryAccountId}
                    onChange={(id) => state.update(candidate, { recoveryAccountId: id })}
                    groups={groupedRecoveryDestinationAccounts(
                      accounts,
                      draft.recoveryAccountId,
                      effectiveDate,
                    )}
                    dataUi={UI.allocations.recurringSettlementRecoveryTo}
                  />
                ) : null}
                <fieldset
                  className="field picker"
                  data-ui={UI.allocations.recurringSettlementRemainder}
                >
                  <legend className="field__label">
                    {t('ccItem.archiveRemainder', {
                      amount: moneyText(rest, currency, candidate.digits),
                    })}
                  </legend>
                  <span className="field__hint">
                    {remainderChoosable
                      ? draft.remainderMode === 'expense'
                        ? t('ccItem.archiveRemainderExpenseHint', { account: expenseAccountName })
                        : t('ccItem.archiveRemainderSpreadHint')
                      : t('ccItem.archiveRemainderNoneHint')}
                  </span>
                  <div className="picker__chips">
                    {(
                      [
                        [
                          'spread',
                          'ccItem.archiveRemainderSpread',
                          UI.allocations.recurringSettlementRemainderSpread,
                        ],
                        [
                          'expense',
                          'ccItem.archiveRemainderExpense',
                          UI.allocations.recurringSettlementRemainderExpense,
                        ],
                      ] as const
                    ).map(([mode, labelKey, dataUi]) => (
                      <label className="chip" key={mode}>
                        <input
                          type="radio"
                          className="sr-only"
                          name={`rule-settlement-remainder-${candidate.item.id}`}
                          value={mode}
                          checked={
                            remainderChoosable ? draft.remainderMode === mode : mode === 'spread'
                          }
                          disabled={!remainderChoosable}
                          onChange={() => state.update(candidate, { remainderMode: mode })}
                          data-ui={dataUi}
                        />
                        <span className="chip__check" aria-hidden="true">
                          <Icon name="check" size={14} />
                        </span>
                        <span className="chip__text">{t(labelKey)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 切り替えシート = 「同じ位置から別の線」を **1 枚で決める**（作者確定 2026-08-16）。
 *
 * 動詞の分離: 「編集 = 全期間（過去も引き直す）」に対して「切り替え = この日から」。
 *  1. **切り替え日**: 既定 = 今日。旧線分はこの日より前まで・この日の起票から後継が担当する
 *     （半開区間 [startDate, endDate)）。
 *  2. **新しい条件**: 金額・起票日・周期。既定は現在のルール値。位相（起票周期の基準月）と
 *     科目・月割りトグルは旧線分から引き継ぐ（保存境界が同じ規則で写す）。
 *  3. **起票プレビュー**: 旧線分の終わりと、新条件での初回起票日を文で出す（重複の防波堤）。
 *  4. **清算パネル**: 台帳経由のルールだけ。配分中 item を「そのまま使い切る / この日で終える」。
 *
 * 状態を変える操作だが、**シートそのものが確認面**なので前置きの確認ダイアログは置かない。
 * 保存は switchRecurringRule 1 回（旧線分の終了・後継の作成・清算・回収の振替が同一 tx）。
 */
function RecurringRuleSwitchSheet({ rule, onClose }: { rule: RecurringRule; onClose: () => void }) {
  const { switchRecurringRule } = useLedger();
  const fractionDigits = useMoneyDigits();
  const [effectiveDate, setEffectiveDate] = useState(() => todayLocal());
  const initialAmountText = formatMinorForInput(rule.amount, fractionDigits);
  const [amountText, setAmountText] = useState(initialAmountText);
  // 変更判定はフラグではなく値（初期表示と同じ文字列に戻れば無変更 = 保存済み minor を保持）。
  const amountDirty = amountText !== initialAmountText;
  const [dayText, setDayText] = useState(String(rule.dayOfMonth));
  const [everyText, setEveryText] = useState(String(rule.everyMonths));
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const settlements = useRecurringSettlements(rule, effectiveDate);

  // 起票プレビュー: 新条件で最初に起票される実際の日付（保存はしない・読み取り専用）。
  // 位相は旧線分の startMonth を引き継ぐので、起票日・周期を変えると初回がどこへ動くかが
  // そのまま画面に出る。どれかの入力が不正な間は行ごと出さない（fail-closed）。
  const previewDay = dayText === '' ? Number.NaN : Number.parseInt(dayText, 10);
  const previewEvery = everyText === '' ? Number.NaN : Number.parseInt(everyText, 10);
  const dateValid = isValidIsoDate(effectiveDate);
  const previewValid =
    dateValid &&
    Number.isInteger(previewDay) &&
    previewDay >= 1 &&
    previewDay <= 31 &&
    Number.isInteger(previewEvery) &&
    previewEvery >= 1 &&
    previewEvery <= CATCH_UP_HARD_CAP_MONTHS;
  const firstPosting = previewValid
    ? firstRecurringPostingDate({
        startMonth: rule.startMonth,
        dayOfMonth: previewDay,
        everyMonths: previewEvery,
        startDate: effectiveDate,
      })
    : null;

  async function submit(): Promise<void> {
    if (submittingRef.current) return;
    const amount = amountDirty ? (parseAmountToMinor(amountText) ?? 0) : rule.amount;
    if (!Number.isInteger(amount) || amount < 1) {
      setError(t('error.common.amountInvalid'));
      return;
    }
    const dayOfMonth = dayText === '' ? 0 : Number.parseInt(dayText, 10);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      setError(t('error.recurring.dayOfMonthInvalid'));
      return;
    }
    const everyMonths = everyText === '' ? 0 : Number.parseInt(everyText, 10);
    if (
      !Number.isInteger(everyMonths) ||
      everyMonths < 1 ||
      everyMonths > CATCH_UP_HARD_CAP_MONTHS
    ) {
      setError(t('error.recurring.everyMonthsInvalid'));
      return;
    }
    if (!dateValid) {
      setError(t('error.recurring.periodInvalid'));
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await switchRecurringRule({
        ruleId: rule.id,
        effectiveDate,
        successor: { amount, dayOfMonth, everyMonths },
        ...(settlements.inputs.length > 0 ? { settlements: settlements.inputs } : {}),
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('recurring.switchTitle')}
      onClose={onClose}
      dataUi={UI.allocations.recurringSwitchSheet}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={
              submitting ||
              effectiveDate === '' ||
              amountText === '' ||
              dayText === '' ||
              everyText === '' ||
              !settlements.canSave
            }
            data-ui={UI.allocations.recurringSwitchConfirm}
          >
            {t('recurring.switchConfirm')}
          </button>
        </>
      }
    >
      <div className="stack">
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        <div className="list__title">{rule.name}</div>
        <TextInput
          label={t('recurring.switchDate')}
          type="date"
          required
          value={effectiveDate}
          onChange={setEffectiveDate}
          hint={t('recurring.switchDateHint')}
          dataUi={UI.allocations.recurringSwitchDate}
        />
        <p className="section-label">{t('recurring.switchNewConditions')}</p>
        <TextInput
          label={t('recurring.amount')}
          required
          inputMode={fractionDigits === 0 ? 'numeric' : 'decimal'}
          value={amountText}
          onChange={(v) => setAmountText(sanitizeAmountText(v, fractionDigits, amountText))}
          dataUi={UI.allocations.recurringSwitchAmount}
        />
        <TextInput
          label={t('recurring.switchDayOfMonth')}
          required
          inputMode="numeric"
          value={dayText}
          onChange={(v) => setDayText(v.replace(/[^\d]/g, ''))}
          hint={t('recurring.switchDayOfMonthHint')}
          dataUi={UI.allocations.recurringSwitchDayOfMonth}
        />
        <TextInput
          label={t('recurring.intervalMonths')}
          required
          inputMode="numeric"
          value={everyText}
          onChange={(v) => setEveryText(v.replace(/[^\d]/g, ''))}
          dataUi={UI.allocations.recurringSwitchEvery}
        />
        {dateValid ? (
          <div className="field" data-ui={UI.allocations.recurringSwitchPreview}>
            <span className="field__label">{t('recurring.switchPreview')}</span>
            <p className="field__hint">
              {t('recurring.switchPreviewPredecessor', { date: effectiveDate })}
            </p>
            {previewValid ? (
              <p className="field__hint">
                {firstPosting !== null
                  ? t('recurring.switchPreviewSuccessor', { date: firstPosting })
                  : t('recurring.switchPreviewSuccessorNone')}
              </p>
            ) : null}
          </div>
        ) : null}
        <RecurringSettlementPanel state={settlements} effectiveDate={effectiveDate} />
      </div>
    </Modal>
  );
}

/**
 * ルールの終了 = 明示的に終了点を打つ（継続コスト item のアーカイブと同じ型の小シート）。
 * 既定 = 「今日で終了する」ときに置ける最小の排他的終了日（earliestRecurringRuleEndDate）。
 * v13: 判定材料は保存仕訳ではなく**今日までの導出行**（保存 rec- は存在しない）。
 * 既定より前の終了点も入力自体は許す — 存在期間の短縮は「生まれたものを消す」ための
 * 正当な操作（作者確定 2026-08-16）で、その場合は当日までの導出も一緒に消える。
 * 終了点は含まない端点なので、一覧の「{date} より前まで」と同じ意味を hint で言い直す。
 *
 * 保存は切り替えと同じ switchRecurringRule（successor = null = 後継を作らない）。清算を
 * 選ばなければ settlements は空 = 終了点だけが入る（従来と同じ結果）。
 */
function RecurringRuleEndSheet({ rule, onClose }: { rule: RecurringRule; onClose: () => void }) {
  const { ledger, switchRecurringRule } = useLedger();
  const [endDate, setEndDate] = useState(() =>
    earliestRecurringRuleEndDate(
      rule,
      deriveRecurringOutputs([rule], ledger?.accounts ?? [], todayLocal()).entries,
      todayLocal(),
    ),
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const settlements = useRecurringSettlements(rule, endDate);

  async function submit(): Promise<void> {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await switchRecurringRule({
        ruleId: rule.id,
        effectiveDate: endDate,
        successor: null,
        ...(settlements.inputs.length > 0 ? { settlements: settlements.inputs } : {}),
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('recurring.endSheetTitle')}
      onClose={onClose}
      dataUi={UI.allocations.recurringEndSheet}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={submitting || endDate === '' || !settlements.canSave}
            data-ui={UI.allocations.recurringEndSheetConfirm}
          >
            {t('recurring.endSheetConfirm')}
          </button>
        </>
      }
    >
      <div className="stack">
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        <div className="list__title">{rule.name}</div>
        <TextInput
          label={t('recurring.endSheetDate')}
          type="date"
          required
          value={endDate}
          onChange={setEndDate}
          hint={t('recurring.endSheetBody')}
          dataUi={UI.allocations.recurringEndSheetDate}
        />
        <RecurringSettlementPanel state={settlements} effectiveDate={endDate} />
      </div>
    </Modal>
  );
}

/**
 * アーカイブシート = 終了日と残存価値の始末を **1 枚で決める**（作者決定 2026-08-15）。
 * 旧「終了日ダイアログ →（残存価値が残れば）振替シート」の 2 段構えは撤去した。
 * 状態を変える操作だが、**シートそのものが確認面**なので前置きの確認ダイアログは置かない。
 *
 *  1. **終了日**: 既定 = 今日。終了済みの行だけ現在の終了日（先へ動かせば一覧へ戻る = 復元）。
 *  2. **回収額**: 既定 = その終了日時点の残存価値。編集可・0（回収なし）も超過回収も許す。
 *     終了日を動かすと、まだ手で直していない限り既定が追従する（判定はフラグでなく値）。
 *     0 のときは回収先ピッカーを出さない（作る仕訳が無いので選ばせない）。
 *  3. **残り（残存価値 − 回収額）の扱い**:
 *     - 「期間に割り振る」（既定・現行挙動）= 残りは spreadTotal に残り、全期間へ配り直される。
 *     - 「終了日に全額費用にする」= item の費用の行き先への**第 2 の回収の振替**を足す。
 *       割り振る総額が「終了日までに消費済みの額」へ落ちるので、過去の刻みは元の額のまま
 *       残りが終了日に 1 本だけ立つ（monthlyCost.ts の数学もフィールドも増やさない）。
 *     残りが 0 以下（ちょうど回収・超過回収）なら選ぶ意味が無いので無効化する。
 *
 * 保存は終了日 + 回収の振替（0〜2 本）を同一トランザクションで（archiveMonthlyCost）。
 */
function MonthlyCostArchiveSheet({
  item,
  spreadTotal,
  onClose,
}: {
  item: MonthlyCostItem;
  spreadTotal: number;
  onClose: () => void;
}) {
  const { ledger, archiveMonthlyCost } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? '';
  const displayDigits = useMoneyDigits();
  // 既定 = 今日。終了済みの行だけ現在の endDate（先へ動かせば一覧へ戻る = 復元も同じ 1 操作）。
  const [endDate, setEndDate] = useState(() =>
    isArchived(item, todayLocal()) && item.endDate !== undefined ? item.endDate : todayLocal(),
  );
  const [recoveryAccountId, setRecoveryAccountId] = useState('');
  const [remainderMode, setRemainderMode] = useState<'spread' | 'expense'>('spread');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const dateValid = isValidIsoDate(endDate);
  // 変更前の item の割り振りで「その日までに費用になっていない残り」。
  // remainingValue が回収済みを織り込んだ単一正本（spreadTotal − 月割り済み）なので、
  // ここで回収額をもう一度引かない（一覧と同じ値になる・監査 P2-1）。
  const remaining = remainingValue(item, dateValid ? endDate : todayLocal(), spreadTotal);
  // 表示桁 0 の設定でも、この欄だけは端数を隠さない（見えている値 = 保存される値）。
  const digits = Math.max(displayDigits, exactDigitsFor(remaining)) as typeof displayDigits;

  // 回収額の既定は終了日に追従する。過去に超過回収していて残存価値が負なら既定 0
  //（マイナスは入力欄に載せない。超過をさらに増やしたいなら手で入れる）。
  const defaultRecoveryText = formatMinorForInput(Math.max(remaining, 0), digits);
  const [recoveryText, setRecoveryText] = useState(defaultRecoveryText);
  const autoRecoveryRef = useRef(defaultRecoveryText);
  useEffect(() => {
    if (defaultRecoveryText === autoRecoveryRef.current) return;
    const previousAuto = autoRecoveryRef.current;
    autoRecoveryRef.current = defaultRecoveryText;
    // 既定のままなら追従し、手で直してあればその値を尊重する（判定はフラグではなく値）。
    setRecoveryText((current) => (current === previousAuto ? defaultRecoveryText : current));
  }, [defaultRecoveryText]);

  const recoveryAmount = parseAmountToMinor(recoveryText) ?? 0;
  // 残り = 残存価値 − 回収額。負（超過回収）なら従来どおり spreadTotal が負になり、
  // 過去にわたる費用減として按分される＝「終了日に全額」は選べない。
  const rest = remaining - recoveryAmount;
  const remainderChoosable = dateValid && rest > 0;
  const toExpense = remainderChoosable && remainderMode === 'expense';
  const expenseAccountName =
    accounts.find((a) => a.id === item.expenseAccountId)?.name ?? item.expenseAccountId;
  const recoveryGroups = groupedRecoveryDestinationAccounts(
    accounts,
    recoveryAccountId,
    dateValid ? endDate : undefined,
  );
  const canSave = dateValid && (recoveryAmount === 0 || recoveryAccountId !== '');

  async function submit(): Promise<void> {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      const recoveries: { destinationAccountId: string; amount: number }[] = [];
      if (recoveryAmount > 0) {
        recoveries.push({ destinationAccountId: recoveryAccountId, amount: recoveryAmount });
      }
      // 第 2 の回収の振替（借方 = item の費用の行き先 / 貸方 = 継続コスト台帳）。
      if (toExpense) {
        recoveries.push({ destinationAccountId: item.expenseAccountId, amount: rest });
      }
      await archiveMonthlyCost({
        id: item.id,
        endDate,
        ...(recoveries.length > 0 ? { recoveries } : {}),
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('ccItem.archiveTitle')}
      onClose={onClose}
      dataUi={UI.allocations.archiveDialog}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={submitting || !canSave}
            data-ui={UI.allocations.archiveConfirm}
          >
            {t('ccItem.archiveConfirm')}
          </button>
        </>
      }
    >
      <div className="stack">
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        <div className="list__title">{item.name}</div>
        <TextInput
          label={t('ccItem.endDate')}
          type="date"
          required
          value={endDate}
          onChange={setEndDate}
          hint={t('ccItem.archiveDateHint')}
          dataUi={UI.allocations.archiveDate}
        />
        <div className="kv">
          <span className="muted">{t('ccItem.remainingValue')}</span>
          <span>{moneyText(remaining, currency, digits)}</span>
        </div>
        <TextInput
          label={t('ccItem.archiveRecovery')}
          inputMode={digits === 0 ? 'numeric' : 'decimal'}
          value={recoveryText}
          onChange={(v) => setRecoveryText(sanitizeAmountText(v, digits, recoveryText))}
          hint={t('ccItem.archiveRecoveryHint')}
          dataUi={UI.allocations.archiveRecoveryAmount}
        />
        {/* 回収額 0 = 作る仕訳が無い。回収先は出さない（選ばせて捨てない）。 */}
        {recoveryAmount > 0 ? (
          <AccountPicker
            label={t('ccItem.archiveRecoveryTo')}
            required
            value={recoveryAccountId}
            onChange={setRecoveryAccountId}
            groups={recoveryGroups}
            dataUi={UI.allocations.archiveRecoveryTo}
          />
        ) : null}
        <fieldset className="field picker" data-ui={UI.allocations.archiveRemainder}>
          <legend className="field__label">
            {t('ccItem.archiveRemainder', { amount: moneyText(rest, currency, digits) })}
          </legend>
          <span className="field__hint">
            {remainderChoosable
              ? remainderMode === 'expense'
                ? t('ccItem.archiveRemainderExpenseHint', { account: expenseAccountName })
                : t('ccItem.archiveRemainderSpreadHint')
              : t('ccItem.archiveRemainderNoneHint')}
          </span>
          <div className="picker__chips">
            {(
              [
                ['spread', 'ccItem.archiveRemainderSpread', UI.allocations.archiveRemainderSpread],
                [
                  'expense',
                  'ccItem.archiveRemainderExpense',
                  UI.allocations.archiveRemainderExpense,
                ],
              ] as const
            ).map(([mode, labelKey, dataUi]) => (
              <label className="chip" key={mode}>
                <input
                  type="radio"
                  className="sr-only"
                  name="cc-archive-remainder"
                  value={mode}
                  checked={remainderChoosable ? remainderMode === mode : mode === 'spread'}
                  disabled={!remainderChoosable}
                  onChange={() => setRemainderMode(mode)}
                  data-ui={dataUi}
                />
                <span className="chip__check" aria-hidden="true">
                  <Icon name="check" size={14} />
                </span>
                <span className="chip__text">{t(labelKey)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}
