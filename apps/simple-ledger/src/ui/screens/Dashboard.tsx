/*
 * ホーム（初期表示）。日常入力の主導線（収入/支出/振替）、期間の収支・財政状態サマリー、推移。
 */
import { useMemo, useRef, useState } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import type { IconName } from '@snishi/foundation/ui/Icon';
import { Button } from '@snishi/foundation/ui/Button';
import { useLedger } from '../../state/store';
import {
  deriveBalanceSheet,
  deriveProfitAndLoss,
  filterByDateRange,
} from '../../domain/accounting';
import { livingCostBreakdownForRange } from '../../domain/livingCost';
import { DISPLAY_SECTION_GROUPS, type DisplaySectionKey } from '../../domain/displayOrder';
import { reportBasis, type ReportPeriod } from '../../domain/reportPeriod';
import { displayEntriesResultForAsOf } from '../../domain/reportEntries';
import { todayLocal } from '../../util/time';
import { buildSectionTrends } from './breakdownData';
import { Money, moneyText, useMoneyDigits } from '../money';
import { periodLabel } from '../periodLabel';
import { EntryListItem } from '../EntryListItem';
import { TrendChart } from '../components/TrendChart';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { JournalEntry } from '../../domain/types';
import type { Screen } from '../navigation';
import type { FormMode } from '../entryModes';
import type { AllocationsTarget } from './Allocations';
import { entryOpenPlan } from '../entryOpen';
import type { MessageKey } from '../../i18n';
import { ScrollTopButton } from '../ScrollTopButton';
import { assertSafeAmount } from '../../domain/safeSum';
import { InvestmentProjectionTruncationNotice } from '../components/InvestmentProjectionTruncationNotice';
import { AdjustmentUnspreadNotice } from '../components/AdjustmentUnspreadNotice';

/** ホームの仕訳一覧の 1 ページぶん（「さらに表示」で足す刻み）。 */
const HOME_ENTRY_PAGE = 50;

/**
 * 6 カードの見せ方。**並びは持たない**（順序も段組みも `DISPLAY_SECTION_GROUPS` が正本で、
 * ここはラベル・行き先・data-ui だけ）。ラベルのキーは数値レンズの行・グラフの凡例と共有する。
 */
const SECTION_META: Record<
  DisplaySectionKey,
  { labelKey: MessageKey; screen: Screen; dataUi: string; signed?: boolean }
> = {
  revenue: {
    labelKey: 'dashboard.revenue',
    screen: 'incomeBreakdown',
    dataUi: UI.dashboard.statRevenue,
  },
  expense: {
    labelKey: 'dashboard.expense',
    screen: 'expenseBreakdown',
    dataUi: UI.dashboard.statExpense,
  },
  net: {
    labelKey: 'dashboard.netIncome',
    screen: 'netIncome',
    dataUi: UI.dashboard.statNetIncome,
    signed: true,
  },
  totalAssets: {
    labelKey: 'dashboard.assets',
    screen: 'assetsBreakdown',
    dataUi: UI.dashboard.statAssets,
  },
  totalLiabilities: {
    labelKey: 'dashboard.liabilities',
    screen: 'liabilitiesBreakdown',
    dataUi: UI.dashboard.statLiabilities,
  },
  netAssets: {
    labelKey: 'dashboard.netAssets',
    screen: 'netAssets',
    dataUi: UI.dashboard.statNetAssets,
    signed: true,
  },
};

const ENTRY_TYPES: { mode: FormMode; labelKey: MessageKey; icon: IconName; ui: string }[] = [
  { mode: 'income', labelKey: 'entry.type.income', icon: 'income', ui: UI.dashboard.income },
  { mode: 'expense', labelKey: 'entry.type.expense', icon: 'expense', ui: UI.dashboard.expense },
  {
    mode: 'transfer',
    labelKey: 'entry.type.transfer',
    icon: 'transfer',
    ui: UI.dashboard.transfer,
  },
];

export function Dashboard({
  period,
  onPeriodChange,
  onAddEntry,
  onEditEntry,
  onNavigate,
  onOpenJournal,
  onOpenAllocations,
  onOpenAccount,
  onOpenEntry,
}: {
  period: ReportPeriod;
  onPeriodChange: (p: ReportPeriod) => void;
  onAddEntry: (mode: FormMode) => void;
  onEditEntry: (entry: JournalEntry) => void;
  onNavigate: (screen: Screen) => void;
  onOpenJournal: (filter: { from?: string; to?: string }) => void;
  /** 仕訳タップの行き先（entryOpenPlan の実行先）。仕訳一覧と同じ resolver を使う。 */
  onOpenAllocations: (target: AllocationsTarget) => void;
  onOpenAccount: (accountId: string) => void;
  onOpenEntry: (entryId: string) => void;
}) {
  const { ledger } = useLedger();
  const today = todayLocal();
  const basis = useMemo(() => reportBasis(period, today), [period, today]);
  const range = basis.flowRange;
  // Journal へは全期間のときクランプ済み range を渡さない（「未来も表示」トグルを殺さないため）。
  const journalFilter = period.mode === 'all' ? {} : range;
  // 期間内の保存される仕訳（導出行は混ぜない = 自分が付けた記録が埋もれない）。
  // 並び順は loadLedger の既定（日付降順 → createdAt 降順）に乗る。件数上限は撤廃し、
  // 「さらに表示」で HOME_ENTRY_PAGE 件ずつ開く（実ユーズ④・作者決定 2026-08-12:
  // 月内ぶんをその場でスクロールして読めればよく、月をまたぐ遡りは「すべて見る」のまま）。
  const periodEntries = useMemo(
    () => filterByDateRange(ledger?.journalEntries ?? [], range.from, range.to),
    [ledger, range],
  );
  // 表示日（期間）を変えたら表示件数を初期化する（effect を使わない render 中の派生調整）。
  const rangeKey = `${range.from ?? ''}..${range.to}`;
  const [shown, setShown] = useState({ key: rangeKey, count: HOME_ENTRY_PAGE });
  if (shown.key !== rangeKey) setShown({ key: rangeKey, count: HOME_ENTRY_PAGE });
  const visibleEntries = periodEntries.slice(0, shown.count);
  const remaining = periodEntries.length - visibleEntries.length;
  const label = periodLabel(period);
  const listRef = useRef<HTMLUListElement>(null);

  // 「さらに表示」は末尾追記なので既存行は動かない（scrollTo を呼ばない）。ただし最終ページでは
  // ボタン自身が消えてフォーカスが body へ落ちるため、最初に増えた行へ意図的に移す。
  const showMore = () => {
    const firstAdded = visibleEntries.length;
    const willFinish = remaining <= HOME_ENTRY_PAGE;
    setShown((s) => ({ ...s, count: s.count + HOME_ENTRY_PAGE }));
    if (!willFinish) return;
    // 追加行の描画後にフォーカスを移す（ボタンが消えるのは同じコミット）。
    queueMicrotask(() => {
      const rows = listRef.current?.querySelectorAll<HTMLElement>('button.list__item');
      rows?.[firstAdded]?.focus();
    });
  };

  const { pl, bs, livingTotal, investmentProjectionTruncations, unspreadAdjustments } =
    useMemo(() => {
      const accounts = ledger?.accounts ?? [];
      // 導出込み（継続コスト・定期ルール・補正の按分・投資の利回り）。v13.4 ② 以降、
      // 利回りは最後の補正より後の全断面に効く（未来だけでなく過去の断面にも現れる）。
      const display = ledger ? displayEntriesResultForAsOf(ledger, basis.asOf) : null;
      const entries = display?.entries ?? [];
      const breakdown = livingCostBreakdownForRange(accounts, entries, range);
      return {
        pl: deriveProfitAndLoss(accounts, entries, range),
        bs: deriveBalanceSheet(accounts, entries, basis.asOf),
        // 支出合計・純益は domain の値をそのまま使う（UI で式を再実装しない）。
        livingTotal: breakdown.total,
        investmentProjectionTruncations: display?.investmentProjectionTruncations ?? [],
        unspreadAdjustments: display?.unspreadAdjustments ?? [],
      };
    }, [basis.asOf, ledger, range]);

  // 6 分類の金額。値は domain の導出をそのまま使い、恒等行だけ式で作る（UI で式を再実装しない）。
  const sectionAmounts: Record<DisplaySectionKey, number> = {
    revenue: pl.totalRevenue,
    expense: livingTotal,
    net: assertSafeAmount(pl.totalRevenue - livingTotal),
    totalAssets: bs.totalAssets,
    totalLiabilities: bs.totalLiabilities,
    netAssets: bs.netAssets,
  };

  const trend = useMemo(() => buildSectionTrends(period, ledger, today), [period, ledger, today]);
  const visibleProjectionTruncations =
    trend?.investmentProjectionTruncations ?? investmentProjectionTruncations;

  const currency = ledger?.settings.currency ?? '';

  return (
    <>
      <section className="dashboard" aria-labelledby="dashboard-title" data-ui={UI.dashboard.view}>
        <h1 className="sr-only" id="dashboard-title">
          {t('dashboard.title')}
        </h1>

        <InvestmentProjectionTruncationNotice
          truncations={visibleProjectionTruncations}
          accounts={ledger?.accounts ?? []}
        />
        <AdjustmentUnspreadNotice unspread={unspreadAdjustments} />

        {/* 額縁: 収支 + 財政状態の 6 枠を sticky 固定し、下の仕訳だけが流れる
            （実ユーズ④・作者決定 2026-08-12「6枠を固定」）。 */}
        <div className="dashboard__frame" data-ui={UI.dashboard.frame}>
          {/* 「収支」「財政状態」の見出しは撤去（見れば明らか・作者決定 2026-08-14）。
              縮めたぶん仕訳の可視領域を広げる。読み上げは各枠の aria-label（金額込み）が担う。 */}
          {/* カードの順も段組みも表示順マスタ（DISPLAY_SECTION_GROUPS）。収支・純資産は
              恒等式の行としてマスタが自動で式の後ろへ差し込む。 */}
          {DISPLAY_SECTION_GROUPS.map((group, index) => (
            <div
              key={group.key}
              className="stat-grid"
              {...(index > 0 ? { style: { marginTop: 'var(--space-2)' } } : {})}
            >
              {group.sections.map((key) => {
                const meta = SECTION_META[key];
                return (
                  <StatButton
                    key={key}
                    label={t(meta.labelKey)}
                    amount={sectionAmounts[key]}
                    currency={currency}
                    signed={meta.signed === true}
                    onClick={() => onNavigate(meta.screen)}
                    dataUi={meta.dataUi}
                  />
                );
              })}
            </div>
          ))}

          {/* 仕訳の見出しと「すべて見る」も額縁ごと固定する（作者決定 2026-08-14）。
              仕訳をスクロールしても月をまたぐ遡り導線が手元に残る。sticky に含めるぶん
              縦幅は詰める（.dashboard__frame-journal）。 */}
          <div className="dashboard__frame-journal section-label">
            <span>{t('dashboard.entriesOf', { label })}</span>
            {periodEntries.length > 0 ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => onOpenJournal(journalFilter)}
                data-ui={UI.dashboard.journalOpenAll}
              >
                {t('dashboard.viewAll')}
                <Icon name="chevronRight" size={14} />
              </button>
            ) : null}
          </div>
        </div>

        {trend ? (
          <div data-ui={UI.period.trend}>
            <TrendChart
              title={t('dashboard.trendNet')}
              data={trend.net}
              currency={currency}
              variant="bar"
              dataUi={UI.period.trendChart}
              pointDataUi={UI.period.trendPoint}
              {...(trend.drillable
                ? {
                    onSelect: (key: string) =>
                      onPeriodChange({ mode: 'year', year: Number.parseInt(key, 10) }),
                    selectHint: t('dashboard.trendDrillYear'),
                  }
                : {})}
            />
            <TrendChart
              title={t('dashboard.trendLiving')}
              data={trend.living}
              currency={currency}
              variant="bar"
            />
            <TrendChart
              title={t('dashboard.trendAssets')}
              data={trend.netAssets}
              currency={currency}
              variant="line"
            />
            {trend.drillable ? <p className="field__hint">{t('period.trendYearHint')}</p> : null}
          </div>
        ) : null}

        {periodEntries.length === 0 ? (
          <div className="card card--pad muted">{t('dashboard.noMonthEntries')}</div>
        ) : (
          <>
            <ul
              ref={listRef}
              className="card list dashboard__entries"
              data-ui={UI.dashboard.journalPreview}
            >
              {visibleEntries.map((entry) => {
                {
                  /* 何を開くかは entryOpenPlan（単一正本）。以前は継続コスト絡みの行だけ
                    仕訳一覧へ飛ばしており、「タップで編集 or 由来へ」の原則から外れていた。 */
                }
                const plan = entryOpenPlan(entry);
                const onClick =
                  plan.kind === 'none'
                    ? undefined
                    : plan.kind === 'rule'
                      ? () => onOpenAllocations({ ruleId: plan.ruleId })
                      : plan.kind === 'item'
                        ? () => onOpenAllocations({ itemId: plan.itemId })
                        : plan.kind === 'account'
                          ? () => onOpenAccount(plan.accountId)
                          : plan.kind === 'edit'
                            ? () => onEditEntry(entry)
                            : // opening / adjustment は専用シートが要る。仕訳一覧の該当行を
                              // 直接開く（シートが開いた状態で遷移する既存の resolver を使う）。
                              // 補正は按分スライスなので、開くのは宣言した stored の pin。
                              plan.kind === 'adjustment'
                              ? () => onOpenEntry(plan.entryId)
                              : () => onOpenEntry(entry.id);
                return (
                  <EntryListItem
                    key={entry.id}
                    entry={entry}
                    accounts={ledger?.accounts ?? []}
                    currency={currency}
                    {...(onClick ? { onClick } : {})}
                  />
                );
              })}
            </ul>
            {/* 追加結果を読み上げる（ボタンが消える最終ページでは何も起きなかったように見えるため）。 */}
            <p className="sr-only" role="status" data-ui={UI.dashboard.journalCount}>
              {t('dashboard.shownCount', {
                shown: visibleEntries.length,
                total: periodEntries.length,
              })}
            </p>
            {remaining > 0 ? (
              // 末尾追記のみ（scrollTo を呼ばない = 既に表示中の行は動かない）。
              <Button variant="ghost" block dataUi={UI.dashboard.journalMore} onClick={showMore}>
                {t('dashboard.moreEntries', { count: remaining })}
              </Button>
            ) : null}
          </>
        )}
        <ScrollTopButton />
      </section>

      <div
        className="entry-bar"
        role="group"
        aria-label={t('dashboard.entryActions')}
        data-ui={UI.dashboard.entryBar}
      >
        <div className="entry-bar__inner">
          {ENTRY_TYPES.map((ty) => (
            <button
              key={ty.mode}
              type="button"
              className="entry-type-btn"
              onClick={() => onAddEntry(ty.mode)}
              data-ui={ty.ui}
            >
              <span className="entry-type-btn__icon">
                <Icon name={ty.icon} size={20} />
              </span>
              {t(ty.labelKey)}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * ホームの 6 枠。aria-label は子の金額を上書きするので、**名称・金額・操作の 3 つを含める**
 * （label だけだと読み上げから金額が消える。額縁として固定した主要情報なので必須）。
 * 表示と読み上げが食い違わないよう、金額は Money と同じ moneyText から作る。
 */
function StatButton({
  label,
  amount,
  currency,
  signed = false,
  onClick,
  dataUi,
}: {
  label: string;
  amount: number;
  currency: string;
  signed?: boolean;
  onClick: () => void;
  dataUi?: string;
}) {
  const digits = useMoneyDigits();
  return (
    <button
      type="button"
      className="stat stat--btn"
      onClick={onClick}
      aria-label={t('dashboard.statDetail', {
        label,
        amount: moneyText(amount, currency, digits, signed),
      })}
      data-ui={dataUi}
    >
      <span className="stat__label" aria-hidden="true">
        {label} <Icon name="chevronRight" size={12} />
      </span>
      <span className="stat__value" aria-hidden="true">
        <Money amount={amount} currency={currency} signed={signed} />
      </span>
    </button>
  );
}
