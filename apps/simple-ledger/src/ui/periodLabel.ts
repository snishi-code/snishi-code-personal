import { t } from '../i18n';
import type { ReportPeriod } from '../domain/reportPeriod';

/** 共有レポート期間の表示ラベル。UI 文言は i18n を正本にする。 */
export function periodLabel(period: ReportPeriod): string {
  if (period.mode === 'date') {
    return t('period.dateLabel', {
      year: Number.parseInt(period.date.slice(0, 4), 10),
      month: Number.parseInt(period.date.slice(5, 7), 10),
      day: Number.parseInt(period.date.slice(8, 10), 10),
    });
  }
  if (period.mode === 'year') return t('period.yearUnit', { year: period.year });
  return t('period.allPeriod');
}
