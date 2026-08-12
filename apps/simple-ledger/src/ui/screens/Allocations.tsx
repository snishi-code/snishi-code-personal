/*
 * 毎月のもの。
 *  - くり返し記帳（定期ルール）: 実仕訳の自動起票（正本は起票された仕訳）。
 *    貸方・借方を簿記編集で直接指定し、行き先が費用なら自動で継続コスト台帳を経由する。
 *  - 継続コスト資産: 項目名・金額・開始日・終了日の4項目。終了日までの月割りは導出で、
 *    終了日を過ぎたら一覧から消える（アーカイブ = 終了日の設定）。
 */
import { useMemo, useRef, useState } from 'react';
import { Modal } from '../overlays';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { AccountPicker } from '../AccountPicker';
import { FlowField } from '../FlowField';
import { SearchInput, SortControls } from '../ListSearchSort';
import { applySort, matchesQuery } from '../listQuery';
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
import { recoveredAmountsByItem } from '../../domain/continuousCost';
import { parseRuleItemId } from '../../domain/recurringIds';
import type { AccountRole } from '../../domain/accountRoles';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../../domain/constants';
import { lastExpenseCategoryId, rememberExpenseCategoryId } from '../../data/localFlags';
import { sortAccounts } from '../../domain/accountOrder';
import {
  defaultMonthlyAllocationAccountId,
  groupedAccountsByRole,
  monthlyAllocationAccountOptions,
} from '../accountOptions';
import { monthlyAmounts, monthOf } from '../../domain/allocation';
import { isValidIsoDate } from '../../domain/calendar';
import { reportBasis, type ReportPeriod } from '../../domain/reportPeriod';
import { nowIso, todayLocal } from '../../util/time';
import {
  CATCH_UP_HARD_CAP_MONTHS,
  RECURRING_POSTABLE_ROLES,
  clampDayToMonth,
  firstRecurringPostingDate,
  isRecurringSpreadDestinationRole,
  recurringDestinationAccountId,
  recurringExpenseAccountId,
  recurringKindOf,
  type RecurringKind,
} from '../../domain/recurring';
import {
  accountExistsAt,
  earliestRecurringRuleEndDate,
  effectiveRecurringRuleStartDate,
  recurringRuleLastExistingDate,
  ruleExistsAt as recurringRuleExistsAt,
} from '../../domain/accountLifetime';
import { quickSpanEndDate } from '../ccQuickSpan';
import { Money } from '../money';
import { EntrySheet } from './EntrySheet';
import { errorText, t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { UI } from '../../ui-contract';
import type { JournalEntry, MonthlyCostItem, RecurringRule } from '../../domain/types';

/** 仕訳一覧から「この行はどこから来たか」で遷移してくるときの対象。 */
export interface AllocationsTarget {
  itemId?: string;
  ruleId?: string;
}

/** 並び替え state。軸は両セクション（定期ルール・継続コスト資産）に定義できるものだけ。 */
interface ListSort {
  key: 'default' | 'amount' | 'name';
  direction: 'asc' | 'desc';
}

/** 軸ごとの既定方向（金額 = 大きい順・名称 = 五十音順）。軸を切り替えたらここへ戻す。 */
const SORT_DEFAULT_DIRECTION: Record<ListSort['key'], ListSort['direction']> = {
  default: 'desc',
  amount: 'desc',
  name: 'asc',
};

export function Allocations({
  period,
  onEditEntry,
  target,
}: {
  /** ヘッダーで選んだ断面。「毎月のもの」の一覧・表示額だけがこの日付に追従する。 */
  period: ReportPeriod;
  /** 購入の仕訳を開く（開始日の変更は仕訳側で行う）。 */
  onEditEntry: (entry: JournalEntry) => void;
  /** 仕訳一覧の計算で生まれた行タップからの遷移対象（開くシート。同一オブジェクトは 1 回だけ消費）。 */
  target?: AllocationsTarget | null;
}) {
  const { ledger, removeMonthlyCost, createRecurringRule, saveRecurringRule, removeRecurringRule } =
    useLedger();
  const [showEnded, setShowEnded] = useState(false);
  const [query, setQuery] = useState('');
  // 並び替え（表示専用・保存しない）。軸と方向を 1 つの state で持ち、軸を切り替えたら
  // 方向を軸ごとの既定へ戻す（方向 Segmented 非表示中に古い方向が残らない）。
  const [sort, setSort] = useState<ListSort>({ key: 'default', direction: 'desc' });
  const [pendingDelete, setPendingDelete] = useState<MonthlyCostItem | null>(null);
  const [itemSheet, setItemSheet] = useState<{ existing?: MonthlyCostItem } | null>(null);
  const [archiving, setArchiving] = useState<MonthlyCostItem | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [ruleSheet, setRuleSheet] = useState<{ existing?: RecurringRule } | null>(null);
  const [pendingRuleDelete, setPendingRuleDelete] = useState<RecurringRule | null>(null);
  const [pendingRuleActionId, setPendingRuleActionId] = useState<string | null>(null);
  const ruleActionInFlight = useRef(false);
  // 表示だけはヘッダーの断面へ追従する。シート内の書込日・catch-up は period を受け取らず、
  // 引き続き実際の今日を基準にする（過去/未来表示が durable state を動かさない）。
  const today = todayLocal();
  const asOf = reportBasis(period, today).asOf;
  const currentYm = monthOf(asOf);
  const currency = ledger?.settings.currency ?? 'JPY';

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
  const spreadTotalOf = (m: MonthlyCostItem): number => m.amount - (recovered.get(m.id) ?? 0);
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

  const allItems = ledger?.monthlyCostItems ?? [];
  // 開始前の項目はその断面にはまだ存在しない。showEnded は終了済みだけを再表示し、
  // 未来開始の項目まで先取りしない。
  const startedItems = allItems.filter((m) => m.startDate <= asOf);
  const allRules = ledger?.recurringRules ?? [];
  const startedRules = allRules.filter((r) => effectiveRecurringRuleStartDate(r) <= asOf);
  // 「終了分も表示」の出現条件は検索前の全件で判定する（検索で 0 件になっても、
  // 母集合を変える唯一のコントロールを消さない）。
  const hasEndedAtAsOf =
    startedRules.some((r) => !recurringRuleExistsAt(r, asOf)) ||
    startedItems.some((m) => isArchived(m, asOf));
  const hasAnyStarted = startedRules.length > 0 || startedItems.length > 0;

  // 検索: 1 つの検索欄が両セクションに効く（「終了分も表示」と同じ単一 state の型）。
  // 対象 = 名前 + 関係する科目名（Journal と同じ範囲。金額・日付・種別タグは対象外）。
  const dir = sort.direction === 'asc' ? 1 : -1;
  const itemCompare =
    sort.key === 'default'
      ? null
      : sort.key === 'amount'
        ? (a: MonthlyCostItem, b: MonthlyCostItem) => (a.amount - b.amount) * dir
        : (a: MonthlyCostItem, b: MonthlyCostItem) => a.name.localeCompare(b.name, 'ja') * dir;
  const ruleCompare =
    sort.key === 'default'
      ? null
      : sort.key === 'amount'
        ? (a: RecurringRule, b: RecurringRule) => (a.amount - b.amount) * dir
        : (a: RecurringRule, b: RecurringRule) => a.name.localeCompare(b.name, 'ja') * dir;
  // loadLedger は終了が近い順で返すが、編集直後の state 由来でも順序が崩れないよう再ソートする。
  // 並び替え「標準」は applySort が素通しする＝既定の並び（終了が近い順）を 1 行も変えない。
  const items = applySort(
    [...startedItems]
      .filter((m) => showEnded || !isArchived(m, asOf))
      .filter((m) => matchesQuery([m.name, accountsMap.get(m.expenseAccountId)?.name], query))
      .sort(compareMonthlyCostItems),
    itemCompare,
  );
  // 定期ルールの既定順 = loadLedger の createdAt 昇順（画面側では並べ替えない暗黙の既定。
  // 「標準」はこれを素通しする）。
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

  const runRecurringRuleAction = async (
    ruleId: string,
    action: () => Promise<void>,
  ): Promise<void> => {
    if (ruleActionInFlight.current) return;
    ruleActionInFlight.current = true;
    setPendingRuleActionId(ruleId);
    try {
      await action();
    } finally {
      ruleActionInFlight.current = false;
      setPendingRuleActionId(null);
    }
  };

  const endRecurringRule = async (rule: RecurringRule): Promise<void> => {
    // 「終了」= 今日以降は生まない。今日すでに起票済みならその事実は存在期間の中にあるので、
    // 終了点は翌日に置く（今日に置くと半開区間の外へ出て保存境界が拒否する）。
    const effectiveDate = earliestRecurringRuleEndDate(
      rule,
      ledger?.journalEntries ?? [],
      todayLocal(),
    );
    await runRecurringRuleAction(rule.id, () =>
      saveRecurringRule({ ...rule, endDate: effectiveDate, updatedAt: nowIso() }),
    );
  };

  const restartRecurringRule = async (rule: RecurringRule): Promise<void> => {
    const effectiveDate = todayLocal();
    await runRecurringRuleAction(rule.id, () =>
      createRecurringRule({
        name: rule.name,
        amount: rule.amount,
        dayOfMonth: rule.dayOfMonth,
        everyMonths: rule.everyMonths,
        debitAccountId: recurringDestinationAccountId(rule),
        creditAccountId: rule.creditAccountId,
        startMonth: rule.startMonth,
        startDate: effectiveDate,
      }),
    );
  };

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
    if (targetItem) setItemSheet({ existing: targetItem });
    else if (targetRule) setRuleSheet({ existing: targetRule });
  }

  return (
    <section aria-labelledby="allocations-title" data-ui={UI.allocations.view}>
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

      {hasEndedAtAsOf ? (
        <label
          style={{
            display: 'inline-flex',
            gap: 8,
            alignItems: 'center',
            minHeight: 'var(--tap)',
            margin: 'var(--space-3) 0 0',
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

      {hasAnyStarted ? (
        <>
          <div className="toolbar" style={{ margin: 'var(--space-3) 0 0' }}>
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
            axisItems={[
              {
                key: 'default',
                label: t('monthly.sortDefault'),
                dataUi: UI.allocations.sortDefault,
              },
              { key: 'amount', label: t('monthlyCost.amount'), dataUi: UI.allocations.sortByAmount },
              { key: 'name', label: t('monthlyCost.name'), dataUi: UI.allocations.sortByName },
            ]}
            axisValue={sort.key}
            onAxisChange={(key) => {
              const next = key === 'amount' || key === 'name' ? key : 'default';
              // 軸を変えたら方向は軸ごとの既定へ戻す（非表示中の方向が残らない）。
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
            showDirection={sort.key !== 'default'}
          />
        </>
      ) : null}

      {!hasAnyStarted ? (
        <div className="card card--pad empty" style={{ margin: 'var(--space-3) 0 var(--space-4)' }}>
          <Icon name="calendar" size={28} />
          <p style={{ marginTop: 'var(--space-3)' }}>{t('monthly.empty')}</p>
        </div>
      ) : query !== '' && rules.length === 0 && items.length === 0 ? (
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
              const canEndToday = activeToday && start < today && r.endDate === undefined;
              const canRestartToday = !activeToday && r.endDate !== undefined && r.endDate <= today;
              return (
                <li key={r.id} className="list__item">
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
                      {name(r.creditAccountId)} → {name(recurringDestinationAccountId(r))}
                      {recurringExpenseAccountId(r, (id) => accountsMap.get(id)?.role) !==
                      undefined ? (
                        <>
                          ・{t('monthlyCost.monthly')}{' '}
                          <Money
                            amount={monthlyAmounts(r.amount, r.everyMonths)[0] ?? 0}
                            currency={currency}
                          />
                        </>
                      ) : null}
                    </div>
                    {ruleRefBroken(r) ? (
                      <div className="field__error" role="alert">
                        {t('recurring.refBroken')}
                      </div>
                    ) : null}
                  </div>
                  <span className="list__amount">
                    <Money amount={r.amount} currency={currency} />
                  </span>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setRuleSheet({ existing: r })}
                      aria-label={`${t('common.edit')}: ${r.name}`}
                      data-ui={UI.allocations.recurringEdit}
                    >
                      <Icon name="edit" size={18} />
                    </button>
                    {canEndToday ? (
                      <button
                        type="button"
                        className="icon-btn"
                        disabled={pendingRuleActionId !== null}
                        onClick={() => endRecurringRule(r).catch(() => undefined)}
                        aria-label={`${t('recurring.end')}: ${r.name}`}
                        data-ui={UI.allocations.recurringEnd}
                      >
                        <Icon name="archive" size={18} />
                      </button>
                    ) : null}
                    {canRestartToday ? (
                      <button
                        type="button"
                        className="icon-btn"
                        disabled={pendingRuleActionId !== null}
                        onClick={() => restartRecurringRule(r).catch(() => undefined)}
                        aria-label={`${t('recurring.restart')}: ${r.name}`}
                        data-ui={UI.allocations.recurringRestart}
                      >
                        <Icon name="restore" size={18} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setPendingRuleDelete(r)}
                      aria-label={`${t('common.delete')}: ${r.name}`}
                      data-ui={UI.allocations.recurringDelete}
                    >
                      <Icon name="delete" size={18} />
                    </button>
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
              const spreadTotal = spreadTotalOf(m);
              const ending = isEndingSoon(m, asOf);
              const monthly = representativeMonthlyAmount(m, spreadTotal);
              return (
                <div
                  className={`card card--pad${ending ? ' card--ending' : ''}`}
                  key={m.id}
                  data-ui={UI.allocations.item}
                  data-ending={ending ? 'true' : undefined}
                >
                  <div
                    className="list__title"
                    style={{
                      marginBottom: 'var(--space-2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>
                      {m.name}
                      {/* くり返し記帳が自動生成した item はルールと同名で並ぶ（buildRuleItem が
                          name: rule.name）ため、検索で「登録した覚えのない項目」に見えないよう
                          由来を名乗る。判定はルール由来 ID の単一正本 parseRuleItemId。 */}
                      {parseRuleItemId(m.id) !== undefined ? (
                        <>
                          {' '}
                          <span className="tag tag--teal">{t('monthlyCost.fromRule')}</span>
                        </>
                      ) : null}
                    </span>
                    <span className="row-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setArchiving(m)}
                        aria-label={`${t('ccItem.archiveTitle')}: ${m.name}`}
                        data-ui={UI.allocations.archive}
                      >
                        <Icon name="archive" size={18} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setItemSheet({ existing: m })}
                        aria-label={`${t('common.edit')}: ${m.name}`}
                        data-ui={UI.allocations.edit}
                      >
                        <Icon name="edit" size={18} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setPendingDelete(m)}
                        aria-label={`${t('common.delete')}: ${m.name}`}
                      >
                        <Icon name="delete" size={18} />
                      </button>
                    </span>
                  </div>
                  <div className="kv">
                    <span className="muted">{t('monthlyCost.amount')}</span>
                    <span>
                      <Money amount={m.amount} currency={currency} />
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
                      {/* 費用化の開始日を遅らせた item だけ、月割りの起点を追加表示（監査 P2-3）。 */}
                      {m.allocationStartDate !== undefined
                        ? `（${t('ccItem.allocationFrom', { date: m.allocationStartDate })}）`
                        : ''}
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

      {pendingDelete ? (
        <ConfirmDialog
          title={t('monthlyCost.deleteConfirmTitle')}
          body={t('monthlyCost.deleteConfirmBody', { name: pendingDelete.name })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            const m = pendingDelete;
            setPendingDelete(null);
            await removeMonthlyCost(m.id).catch(() => undefined);
          }}
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
        <MonthlyCostArchiveDialog
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

      {pendingRuleDelete ? (
        <ConfirmDialog
          title={t('recurring.deleteConfirmTitle')}
          body={t('recurring.deleteConfirmBody', { name: pendingRuleDelete.name })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingRuleDelete(null)}
          onConfirm={async () => {
            const r = pendingRuleDelete;
            setPendingRuleDelete(null);
            await removeRecurringRule(r.id).catch(() => undefined);
          }}
        />
      ) : null}
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
    <Modal
      title={t('monthly.add')}
      onClose={onClose}
      variant="dialog"
      dataUi={UI.allocations.addChooser}
    >
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
 * 行き先が費用・収入（差引形）科目なら保存境界が自動で継続コスト台帳経由へ正規化する。
 */
function RecurringRuleSheet({
  existing,
  onClose,
}: {
  existing?: RecurringRule;
  onClose: () => void;
}) {
  const { ledger, createRecurringRule, saveRecurringRule } = useLedger();
  const accounts = sortAccounts(ledger?.accounts ?? []);
  const currency = ledger?.settings.currency ?? 'JPY';

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
  const [amountText, setAmountText] = useState(
    existing !== undefined ? String(existing.amount) : '',
  );
  const [everyText, setEveryText] = useState(
    existing !== undefined ? String(existing.everyMonths) : '1',
  );
  const [firstPostingDate, setFirstPostingDate] = useState(() =>
    existing ? clampDayToMonth(existing.startMonth, existing.dayOfMonth) : todayLocal(),
  );
  const [startDate, setStartDate] = useState(
    existing ? effectiveRecurringRuleStartDate(existing) : todayLocal(),
  );
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  const [error, setError] = useState<string | undefined>(undefined);
  const [pendingAmountChange, setPendingAmountChange] = useState<{
    rule: RecurringRule;
    effectiveDate: string;
  } | null>(null);
  const [amountChangeError, setAmountChangeError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
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
    isValidIsoDate(startDate) &&
    (endDate === '' || isValidIsoDate(endDate))
      ? firstRecurringPostingDate({
          startMonth: monthOf(firstPostingDate),
          dayOfMonth: resolveRuleDayOfMonth(firstPostingDate, existing),
          everyMonths: previewEvery,
          startDate,
          ...(endDate !== '' ? { endDate } : {}),
        })
      : null;

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
    const amount = amountText === '' ? 0 : Number.parseInt(amountText, 10);
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
    if (!isValidIsoDate(startDate)) {
      setError(t('error.recurring.periodInvalid'));
      return;
    }
    if (endDate !== '' && (!isValidIsoDate(endDate) || endDate <= startDate)) {
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
        // 保存境界が選択した行き先 role から新形式へ正規化する。既存 spread を残すと
        // 変更前の行き先が優先されるため、画面からは常に論理的な借方だけを渡す。
        delete next.spreadExpenseAccountId;
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
          startDate,
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
                startDate === '' ||
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
            inputMode="numeric"
            value={amountText}
            onChange={(v) => setAmountText(v.replace(/[^\d]/g, ''))}
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
                label={
                  // 費用・収入（差引形）行きは台帳経由の月割りになるため「計上先」と表示する。
                  isRecurringSpreadDestinationRole(
                    accounts.find((account) => account.id === debitAccountId)?.role,
                  )
                    ? t('monthlyCost.expenseCategory')
                    : t('recurring.to.manual')
                }
                required
                value={debitAccountId}
                onChange={setDebitAccountId}
                groups={toGroups}
                hint={t('recurring.manualHint')}
                dataUi={UI.allocations.recurringTo}
              />
            }
          />
          <TextInput
            label={t('recurring.intervalMonths')}
            required
            inputMode="numeric"
            value={everyText}
            onChange={(v) => setEveryText(v.replace(/[^\d]/g, ''))}
            dataUi={UI.allocations.recurringEvery}
          />
          {firstPosting !== null ? (
            <div className="kv" data-ui={UI.allocations.recurringFirstPosting}>
              <span className="muted">{t('recurring.firstPosting')}</span>
              <span>{firstPosting}</span>
            </div>
          ) : null}
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
        </div>
      </Modal>
      {pendingAmountChange && existing ? (
        <Modal
          title={t('recurring.amountChangeTitle')}
          variant="dialog"
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
  const { ledger, createContinuousCost, saveMonthlyCost } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const monthlyAllocationOptions = monthlyAllocationAccountOptions(
    accounts,
    existing?.expenseAccountId,
  );

  const [name, setName] = useState(existing?.name ?? '');
  const [amountText, setAmountText] = useState(
    existing !== undefined ? String(existing.amount) : '',
  );
  const [startDate, setStartDate] = useState(existing?.startDate ?? todayLocal());
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  // 費用化の開始日（任意）。空 = 購入日から月割り（既定挙動）。
  const [allocationStartDate, setAllocationStartDate] = useState(
    existing?.allocationStartDate ?? '',
  );
  // 費用の行き先の既定値は「前回選んだもの」（連続登録の切り替え手間を減らす）。
  const [expenseAccountId, setExpenseAccountId] = useState(() => {
    if (existing) return existing.expenseAccountId;
    const last = lastExpenseCategoryId();
    if (last && monthlyAllocationOptions.some((o) => o.value === last)) return last;
    return defaultMonthlyAllocationAccountId(accounts);
  });
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  // 期間クイックボタンの起点 = 費用化の開始日（domain の allocationStartOf と同じ既定:
  // 空 = 購入日）。費用化開始を遅らせた item の「1年」は費用化開始から 1 年になる（監査 P2-1）。
  const quickSpanFrom = allocationStartDate.trim() !== '' ? allocationStartDate.trim() : startDate;

  // 過去から再計算される項目の変更予告（破壊的操作の予告なので削らない）。
  const pastFieldsChanged =
    existing !== undefined &&
    (amountText !== String(existing.amount) ||
      endDate !== (existing.endDate ?? '') ||
      allocationStartDate !== (existing.allocationStartDate ?? '') ||
      expenseAccountId !== existing.expenseAccountId);

  async function submit() {
    if (submitting) return;
    const amount = amountText === '' ? 0 : Number.parseInt(amountText, 10);
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
        if (allocationStartDate.trim() === '') delete next.allocationStartDate;
        else next.allocationStartDate = allocationStartDate.trim();
        await saveMonthlyCost(next);
      } else {
        await createContinuousCost({
          name: name.trim(),
          amount,
          startDate,
          ...(endDate.trim() !== '' ? { endDate: endDate.trim() } : {}),
          ...(allocationStartDate.trim() !== ''
            ? { allocationStartDate: allocationStartDate.trim() }
            : {}),
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
          <div className="field__warning" role="status" data-ui={UI.allocations.editImpactWarning}>
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
          inputMode="numeric"
          value={amountText}
          onChange={(v) => setAmountText(v.replace(/[^\d]/g, ''))}
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
        {/* 費用化の開始日（任意・既定 = 購入日）。購入日〜この日の間は台帳に価値が置かれたまま。 */}
        <TextInput
          label={t('ccItem.allocationStartDate')}
          type="date"
          value={allocationStartDate}
          onChange={setAllocationStartDate}
          dataUi={UI.allocations.editAllocationStartDate}
        />
        <p className="field__hint">{t('ccItem.allocationStartHint')}</p>
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
              onClick={() => setEndDate(quickSpanEndDate(quickSpanFrom, years))}
            >
              {t('ccItem.quickSpan', { years })}
            </button>
          ))}
        </div>
        <SelectInput
          label={t('monthlyCost.expenseCategory')}
          value={expenseAccountId}
          onChange={setExpenseAccountId}
          options={monthlyAllocationOptions}
          dataUi={UI.allocations.editExpense}
        />
      </div>
    </Modal>
  );
}

/**
 * アーカイブ = 終了日の設定。残存価値が残るなら「振替先を選ぶ」でホームの振替と同じシートを
 * 開き、回収の振替（借方 振替先 / 貸方 継続コスト台帳）を同一トランザクションで保存する。
 * 振替せずアーカイブ = 残存価値は全額その月までの費用になる（捨てた・使い切った）。
 * 終了済みの行にも同じボタンを出す（終了日を先へ動かせば一覧に戻る＝復元も同じ 1 操作）。
 */
function MonthlyCostArchiveDialog({
  item,
  spreadTotal,
  onClose,
}: {
  item: MonthlyCostItem;
  spreadTotal: number;
  onClose: () => void;
}) {
  const { ledger, archiveMonthlyCost } = useLedger();
  const currency = ledger?.settings.currency ?? 'JPY';
  // 既定 = 今日。終了済みの行だけ現在の endDate（先へ動かせば一覧へ戻る = 復元も同じ 1 操作）。
  const [endDate, setEndDate] = useState(() =>
    isArchived(item, todayLocal()) && item.endDate !== undefined ? item.endDate : todayLocal(),
  );
  const [transferOpen, setTransferOpen] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  // 変更前の item の割り振りで「その日までに費用になっていない残り」。
  // remainingValue が回収済みを織り込んだ単一正本（spreadTotal − 月割り済み）なので、
  // ここで回収額をもう一度引かない（一覧と同じ値になる・監査 P2-1）。
  const remaining = isValidIsoDate(endDate)
    ? remainingValue(item, endDate, spreadTotal)
    : remainingValue(item, todayLocal(), spreadTotal);

  async function archiveWithoutTransfer() {
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await archiveMonthlyCost({ id: item.id, endDate });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
    <>
      <Modal
        title={t('ccItem.archiveTitle')}
        onClose={onClose}
        variant="dialog"
        dataUi={UI.allocations.archiveDialog}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={archiveWithoutTransfer}
              disabled={submitting || endDate === ''}
              data-ui={UI.allocations.archiveConfirm}
            >
              {t('ccItem.archiveTitle')}
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
            dataUi={UI.allocations.archiveDate}
          />
          <div className="kv">
            <span className="muted">{t('ccItem.remainingValue')}</span>
            <span>
              <Money amount={remaining} currency={currency} />
            </span>
          </div>
          {remaining > 0 ? (
            <button
              type="button"
              className="btn btn--block"
              onClick={() => setTransferOpen(true)}
              disabled={endDate === ''}
              data-ui={UI.allocations.archiveTransfer}
            >
              <Icon name="transfer" size={16} />
              {t('ccItem.transferTarget')}
            </button>
          ) : null}
        </div>
      </Modal>

      {transferOpen ? (
        <EntrySheet
          init={{
            kind: 'transfer-fixed',
            fixed: {
              side: 'credit',
              accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
              counterpartRoles: [...RECURRING_POSTABLE_ROLES],
              date: endDate,
              lockDate: true,
              amount: remaining,
              description: item.name,
              onSave: async (input) => {
                await archiveMonthlyCost({
                  id: item.id,
                  endDate,
                  recovery: {
                    destinationAccountId: input.debitAccountId,
                    amount: input.amount,
                  },
                });
                onClose();
              },
            },
          }}
          onClose={() => setTransferOpen(false)}
        />
      ) : null}
    </>
  );
}
