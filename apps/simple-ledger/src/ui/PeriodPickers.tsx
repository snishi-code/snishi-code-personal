/*
 * 期間の軽量ピッカー。
 * 年・全期間の俯瞰はロジックを維持するが、現時点の UI からは到達手段を持たない
 * （意図的に保留した未完成機能。棚卸しで削除しないこと）。
 * ヘッダーの日付選択はピッカーを経由しない（App のチップに透明な date input を重ねた 1 タップ）。
 */
import { Popup } from './overlays';
import { Icon } from '@snishi/foundation/ui/Icon';
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
