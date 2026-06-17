/*
 * 期間の軽量ピッカー（ヘッダーの現在コンテキスト表示をタップして開く）。
 * foundation の Popup（native <dialog>）を使用。
 */
import { Popup } from '@snishi/foundation/ui/Popup';
import { Icon } from '@snishi/foundation/ui/Icon';
import { t } from '../i18n';
import { UI } from '../ui-contract';
import type { ReportPeriod } from '../domain/reportPeriod';

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

function Row({
  selected,
  label,
  onClick,
  dataUi,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
  dataUi: string;
}) {
  return (
    <button
      type="button"
      className="picker-row"
      aria-current={selected ? 'true' : undefined}
      onClick={onClick}
      data-ui={dataUi}
    >
      <span className="picker-row__check" aria-hidden="true">
        {selected ? <Icon name="check" size={16} /> : null}
      </span>
      {label}
    </button>
  );
}

export function PeriodYearPicker({
  period,
  years,
  onChange,
  onClose,
}: {
  period: ReportPeriod;
  years: number[];
  onChange: (p: ReportPeriod) => void;
  onClose: () => void;
}) {
  const select = (p: ReportPeriod) => {
    onChange(p);
    onClose();
  };
  const pickYear = (year: number): ReportPeriod =>
    period.mode === 'month' ? { mode: 'month', year, month: period.month } : { mode: 'year', year };

  return (
    <Popup ariaLabel={t('period.pickerYear')} onClose={onClose} dataUi={UI.period.yearPicker}>
      <Row
        selected={period.mode === 'all'}
        label={t('period.allPeriod')}
        onClick={() => select({ mode: 'all' })}
        dataUi={UI.period.allRow}
      />
      {years.map((y) => (
        <Row
          key={y}
          selected={period.mode !== 'all' && period.year === y}
          label={t('period.yearUnit', { year: y })}
          onClick={() => select(pickYear(y))}
          dataUi={UI.period.yearRow}
        />
      ))}
    </Popup>
  );
}

export function PeriodMonthPicker({
  period,
  today,
  onChange,
  onClose,
}: {
  period: ReportPeriod;
  today: string;
  onChange: (p: ReportPeriod) => void;
  onClose: () => void;
}) {
  const year = period.mode === 'all' ? Number.parseInt(today.slice(0, 4), 10) : period.year;
  const select = (p: ReportPeriod) => {
    onChange(p);
    onClose();
  };

  return (
    <Popup ariaLabel={t('period.pickerMonth')} onClose={onClose} dataUi={UI.period.monthPicker}>
      <Row
        selected={period.mode === 'year'}
        label={t('period.fullYear')}
        onClick={() => select({ mode: 'year', year })}
        dataUi={UI.period.fullYearRow}
      />
      {MONTHS.map((m) => (
        <Row
          key={m}
          selected={period.mode === 'month' && period.month === m}
          label={t('period.monthUnit', { month: m })}
          onClick={() => select({ mode: 'month', year, month: m })}
          dataUi={UI.period.monthRow}
        />
      ))}
    </Popup>
  );
}
