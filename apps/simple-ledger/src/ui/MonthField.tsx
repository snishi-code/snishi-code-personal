import { useId, useState } from 'react';
import { FieldShell } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { Popup } from './overlays';
import { todayLocal } from '../util/time';

const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);

/** 未設定のときの表示。空文字だとアイコンだけのボタンになり、何の欄か分からなくなる。 */
const MONTH_PLACEHOLDER = 'YYYY-MM';

function monthYear(value: string): number {
  if (/^\d{4}-\d{2}$/.test(value)) return Number.parseInt(value.slice(0, 4), 10);
  return Number.parseInt(todayLocal().slice(0, 4), 10);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Safari / Firefox desktop でも同じ操作になる月選択欄。
 * 永続値は既存どおり YYYY-MM のまま扱う。
 */
export function MonthField({
  label,
  value,
  onChange,
  required,
  hint,
  error,
  dataUi,
  clearLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  hint?: string;
  error?: string;
  dataUi?: string;
  /** 指定時だけ「未設定へ戻す」操作を表示する。 */
  clearLabel?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => monthYear(value));

  const openPicker = () => {
    setYear(monthYear(value));
    setOpen(true);
  };
  const selectMonth = (month: number) => {
    onChange(`${year}-${pad2(month)}`);
    setOpen(false);
  };

  return (
    <>
      <FieldShell id={id} label={label} required={required} hint={hint} error={error}>
        <button
          id={id}
          type="button"
          className="input"
          style={{
            minHeight: 'var(--tap)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            textAlign: 'left',
            cursor: 'pointer',
          }}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
          onClick={openPicker}
          data-ui={dataUi}
        >
          <span className={value === '' ? 'muted' : undefined}>
            {value === '' ? MONTH_PLACEHOLDER : value}
          </span>
          <Icon name="calendar" size={18} />
        </button>
      </FieldShell>

      {open ? (
        <Popup ariaLabel={label} onClose={() => setOpen(false)}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(44px, 1fr) minmax(88px, 2fr) minmax(44px, 1fr)',
              alignItems: 'center',
              gap: 'var(--space-1)',
              marginBottom: 'var(--space-2)',
            }}
          >
            <button
              type="button"
              className="btn btn--ghost"
              style={{ minHeight: 'var(--tap)', paddingInline: 'var(--space-1)' }}
              onClick={() => setYear((current) => current - 1)}
            >
              {year - 1}
            </button>
            <strong style={{ textAlign: 'center' }}>{year}</strong>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ minHeight: 'var(--tap)', paddingInline: 'var(--space-1)' }}
              onClick={() => setYear((current) => current + 1)}
            >
              {year + 1}
            </button>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: 'var(--space-1)',
            }}
          >
            {MONTHS.map((month) => {
              const candidate = `${year}-${pad2(month)}`;
              return (
                <button
                  key={month}
                  type="button"
                  className="btn btn--ghost"
                  style={{ minHeight: 'var(--tap)' }}
                  aria-pressed={candidate === value}
                  onClick={() => selectMonth(month)}
                >
                  {month}
                </button>
              );
            })}
          </div>
          {clearLabel !== undefined ? (
            <button
              type="button"
              className="btn btn--ghost"
              style={{ width: '100%', minHeight: 'var(--tap)', marginTop: 'var(--space-2)' }}
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              {clearLabel}
            </button>
          ) : null}
        </Popup>
      ) : null}
    </>
  );
}
