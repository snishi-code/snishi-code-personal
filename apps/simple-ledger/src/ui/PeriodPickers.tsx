/*
 * 期間の軽量ピッカー（ヘッダーの現在コンテキスト表示をタップして開く）。
 * foundation の Popup（native <dialog>）を使用。
 */
import { useId } from 'react';
import { Popup } from './overlays';
import { Icon } from '@snishi/foundation/ui/Icon';
import { CONTINUOUS_COST_HARD_CAP } from '../domain/continuousCost';
import { t } from '../i18n';
import { UI } from '../ui-contract';
import type { ReportPeriod } from '../domain/reportPeriod';

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
  const pickYear = (year: number): ReportPeriod => ({ mode: 'year', year });

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
          selected={period.mode === 'year' && period.year === y}
          label={t('period.yearUnit', { year: y })}
          onClick={() => select(pickYear(y))}
          dataUi={UI.period.yearRow}
        />
      ))}
    </Popup>
  );
}

/**
 * ヘッダー用の日付ピッカー。年・全期間への導線は意図的に持たない。
 * max = 継続コスト資産エンジンの展開上限（2100-12-31）。エンジンが展開できる範囲の外を
 * そもそも選べなくする（表示日のピッカーだけ。入力欄には付けない）。
 */
export function PeriodDatePicker({
  date,
  onChange,
  onClose,
}: {
  date: string;
  onChange: (date: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const select = (nextDate: string) => {
    if (nextDate === '') return;
    onChange(nextDate);
    onClose();
  };

  return (
    <Popup ariaLabel={t('period.pickerDate')} onClose={onClose} dataUi={UI.period.datePicker}>
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {t('period.date')}
        </label>
        <input
          id={id}
          className="input"
          type="date"
          value={date}
          max={CONTINUOUS_COST_HARD_CAP}
          onChange={(e) => select(e.target.value)}
          data-ui={UI.period.dateInput}
        />
      </div>
    </Popup>
  );
}
