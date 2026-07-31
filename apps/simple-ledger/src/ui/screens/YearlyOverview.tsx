/*
 * 年間・全体ビュー。
 *
 * 表示対象の最大基準日まで reportEntriesForAsOf を一度だけ呼び、展開済み仕訳を
 * periodMatrix の単一走査へ渡す。年送りはこの画面内だけで完結し、ヘッダー期間は変更しない。
 */
import { useMemo, useState } from 'react';
import { Segmented } from '@snishi/foundation/ui/Segmented';
import {
  buildPeriodMatrix,
  periodMatrixAsOf,
  type PeriodMatrixScope,
} from '../../domain/periodMatrix';
import {
  effectiveRecurringRuleStartDate,
  recurringRuleLastExistingDate,
} from '../../domain/accountLifetime';
import { dataYearsOf, type ReportPeriod } from '../../domain/reportPeriod';
import { reportEntriesForAsOf } from '../../domain/reportEntries';
import { recurringPostingsDue } from '../../domain/recurring';
import type { Ledger, MonthlyCostItem } from '../../domain/types';
import { useLedger } from '../../state/store';
import { t } from '../../i18n';
import { todayLocal } from '../../util/time';
import { UI } from '../../ui-contract';
import { Money } from '../money';

type OverviewMode = 'year' | 'all';

function yearOfPeriod(period: ReportPeriod, today: string): number {
  if (period.mode === 'year') return period.year;
  const source = period.mode === 'date' ? period.date : today;
  return Number.parseInt(source.slice(0, 4), 10);
}

/**
 * 実仕訳に加え、複数年へまたがる継続コストと有限の定期ルールの存在期間も
 * 「データのある年」に含める。
 * reportEntriesForAsOf を年候補づくりで別途呼ばず、画面の仕訳展開を常に1回に保つ。
 */
function matrixDataYears(ledger: Ledger, today: string): number[] {
  const dates = ledger.journalEntries.map((entry) => entry.date);
  for (const item of ledger.monthlyCostItems) {
    dates.push(item.startDate);
    addRecognitionYears(dates, item);
  }
  // 起動時catch-upが fail-soft で失敗しても、表示用に投影可能な到来済みルールの年を失わない。
  for (const rule of ledger.recurringRules) {
    const startDate = effectiveRecurringRuleStartDate(rule);
    dates.push(startDate);
    // 有限のルール線分は、まだ実起票が無い未来年も投影できるデータ期間である。
    // endDate は排他的なので、直前の日を最後の表示年として扱う。
    const lastExistingDate = recurringRuleLastExistingDate(rule);
    if (lastExistingDate !== undefined) {
      addSpanYears(dates, startDate, lastExistingDate);
    }
    for (const posting of recurringPostingsDue(rule, today)) dates.push(posting.date);
  }
  return dataYearsOf(dates);
}

function addRecognitionYears(dates: string[], item: MonthlyCostItem): void {
  if (!item.endDate) return;
  addSpanYears(dates, item.startDate, item.endDate);
}

function addSpanYears(dates: string[], startDate: string, endDate: string): void {
  const startYear = Number.parseInt(startDate.slice(0, 4), 10);
  const endYear = Number.parseInt(endDate.slice(0, 4), 10);
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear) || endYear < startYear) return;
  // schema の日付範囲内でも、破損値から無制限に配列を増やさない。
  for (let year = startYear, count = 0; year <= endYear && count < 200; year++, count++) {
    dates.push(`${year}-01-01`);
  }
}

function previousDataYear(years: readonly number[], selectedYear: number): number | undefined {
  for (let index = years.length - 1; index >= 0; index--) {
    const year = years[index];
    if (year !== undefined && year < selectedYear) return year;
  }
  return undefined;
}

export function YearlyOverview({ period }: { period: ReportPeriod }) {
  const { ledger } = useLedger();
  const today = todayLocal();
  const preferredYear = yearOfPeriod(period, today);
  const dataYears = useMemo(() => (ledger ? matrixDataYears(ledger, today) : []), [ledger, today]);
  const [mode, setMode] = useState<OverviewMode>('year');
  // 初期年はヘッダー年そのもの。候補外なら両側の最寄りデータ年へ移動できるが、
  // 画面を開いた瞬間に別の年へ丸めない。
  const [selectedYear, setSelectedYear] = useState(preferredYear);
  const previousYear = previousDataYear(dataYears, selectedYear);
  const nextYear = dataYears.find((year) => year > selectedYear);
  const currency = ledger?.settings.currency ?? 'JPY';

  const scope = useMemo<PeriodMatrixScope>(
    () =>
      mode === 'year' ? { mode: 'year', year: selectedYear } : { mode: 'all', years: dataYears },
    [dataYears, mode, selectedYear],
  );
  const matrix = useMemo(() => {
    if (!ledger || dataYears.length === 0) return null;
    const entries = reportEntriesForAsOf(ledger, periodMatrixAsOf(scope, today));
    return buildPeriodMatrix(ledger.accounts, entries, scope);
  }, [dataYears.length, ledger, scope, today]);

  const caption =
    mode === 'year'
      ? t('yearlyOverview.yearCaption', { year: selectedYear })
      : t('yearlyOverview.allCaption');

  return (
    <section aria-labelledby="yearly-overview-title" data-ui={UI.yearlyOverview.view}>
      <h1 className="screen-title" id="yearly-overview-title">
        {t('yearlyOverview.title')}
      </h1>
      <p className="field__hint yearly-overview__intro">{t('yearlyOverview.intro')}</p>

      <div className="yearly-overview__controls">
        <div className="yearly-overview__mode">
          <Segmented
            value={mode}
            items={[
              {
                key: 'year',
                label: t('yearlyOverview.modeYear'),
                dataUi: UI.yearlyOverview.modeYear,
              },
              {
                key: 'all',
                label: t('yearlyOverview.modeAll'),
                dataUi: UI.yearlyOverview.modeAll,
              },
            ]}
            onChange={(value) => setMode(value === 'all' ? 'all' : 'year')}
          />
        </div>

        {mode === 'year' && dataYears.length > 0 ? (
          <div className="yearly-overview__year-nav">
            <button
              type="button"
              className="btn btn--ghost yearly-overview__year-button"
              disabled={previousYear === undefined}
              aria-label={
                previousYear === undefined
                  ? t('yearlyOverview.noPreviousYear')
                  : t('yearlyOverview.previousYear', { year: previousYear })
              }
              onClick={() => {
                if (previousYear !== undefined) setSelectedYear(previousYear);
              }}
              data-ui={UI.yearlyOverview.prevYear}
            >
              <span aria-hidden="true">←</span>
            </button>
            <strong className="yearly-overview__year" aria-live="polite">
              {t('period.yearUnit', { year: selectedYear })}
            </strong>
            <button
              type="button"
              className="btn btn--ghost yearly-overview__year-button"
              disabled={nextYear === undefined}
              aria-label={
                nextYear === undefined
                  ? t('yearlyOverview.noNextYear')
                  : t('yearlyOverview.nextYear', { year: nextYear })
              }
              onClick={() => {
                if (nextYear !== undefined) setSelectedYear(nextYear);
              }}
              data-ui={UI.yearlyOverview.nextYear}
            >
              <span aria-hidden="true">→</span>
            </button>
          </div>
        ) : null}
      </div>

      {matrix ? (
        <div
          className="yearly-overview__scroll card"
          role="region"
          aria-label={caption}
          tabIndex={0}
          data-ui={UI.yearlyOverview.matrix}
        >
          <table className="yearly-overview__table">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                <th className="yearly-overview__label yearly-overview__corner" scope="col">
                  {t('yearlyOverview.itemColumn')}
                </th>
                {matrix.columns.map((column) => (
                  <th className="yearly-overview__value" scope="col" key={column.key}>
                    {column.month === undefined
                      ? t('period.yearUnit', { year: column.year })
                      : t('yearlyOverview.monthLabel', { month: column.month })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <MatrixRow
                label={t('yearlyOverview.revenue')}
                values={matrix.rows.revenue}
                currency={currency}
              />
              <MatrixRow
                label={t('yearlyOverview.expense')}
                values={matrix.rows.expense}
                currency={currency}
              />
              <MatrixRow
                label={t('yearlyOverview.net')}
                values={matrix.rows.net}
                currency={currency}
                signed
                emphasis
              />
              <MatrixRow
                label={t('yearlyOverview.monthlyCost')}
                values={matrix.rows.monthlyCost}
                currency={currency}
              />
              {matrix.expenseCategories.map(({ account, values }) => (
                <MatrixRow
                  key={account.id}
                  label={account.name}
                  accessibleLabel={t('yearlyOverview.expenseCategory', { name: account.name })}
                  values={values}
                  currency={currency}
                  category
                />
              ))}
              <MatrixRow
                label={t('yearlyOverview.totalAssets')}
                values={matrix.rows.totalAssets}
                currency={currency}
                sectionStart
              />
              <MatrixRow
                label={t('yearlyOverview.netAssets')}
                values={matrix.rows.netAssets}
                currency={currency}
                emphasis
              />
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted yearly-overview__empty">{t('yearlyOverview.noData')}</p>
      )}
    </section>
  );
}

function MatrixRow({
  label,
  accessibleLabel,
  values,
  currency,
  signed = false,
  emphasis = false,
  category = false,
  sectionStart = false,
}: {
  label: string;
  accessibleLabel?: string;
  values: number[];
  currency: string;
  signed?: boolean;
  emphasis?: boolean;
  category?: boolean;
  sectionStart?: boolean;
}) {
  const classes = [
    emphasis ? 'yearly-overview__row--emphasis' : '',
    category ? 'yearly-overview__row--category' : '',
    sectionStart ? 'yearly-overview__row--section' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <tr className={classes || undefined}>
      <th className="yearly-overview__label" scope="row" aria-label={accessibleLabel ?? label}>
        {label}
      </th>
      {values.map((value, index) => (
        <td className="yearly-overview__value" key={index}>
          <Money amount={value} currency={currency} signed={signed} />
        </td>
      ))}
    </tr>
  );
}
