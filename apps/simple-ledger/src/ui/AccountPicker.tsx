/*
 * 勘定科目のチップピッカー（単一選択）。
 * foundation の Field / Icon を使用。
 */
import { useId } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import type { AccountGroup } from './accountOptions';
import { t } from '../i18n';

export function AccountPicker({
  label,
  groups,
  value,
  onChange,
  required,
  hint,
  error,
  dataUi,
  emptyText,
  flat,
}: {
  label: string;
  groups: AccountGroup[];
  value: string;
  onChange: (id: string) => void;
  required?: boolean;
  hint?: string;
  error?: string;
  dataUi?: string;
  emptyText?: string;
  flat?: boolean;
}) {
  const name = useId();
  const errId = `${name}-err`;
  const isEmpty = groups.length === 0;
  const flatAccounts = flat ? groups.flatMap((g) => g.accounts) : [];

  return (
    <fieldset
      className="field picker"
      data-ui={dataUi}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errId : undefined}
    >
      <legend className="field__label">
        {label}
        {required ? (
          <span className="field__req" aria-hidden="true">
            （{t('common.required')}）
          </span>
        ) : null}
      </legend>
      {hint ? <span className="field__hint">{hint}</span> : null}

      {isEmpty ? (
        <p className="muted" style={{ fontSize: 13 }}>
          {emptyText ?? t('entry.noAccounts')}
        </p>
      ) : flat ? (
        <div className="picker__chips">
          {flatAccounts.map((a) => (
            <label className="chip" key={a.id}>
              <input
                type="radio"
                className="sr-only"
                name={name}
                value={a.id}
                checked={value === a.id}
                onChange={() => onChange(a.id)}
              />
              <span className="chip__check" aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
              <span className="chip__text">{a.name}</span>
            </label>
          ))}
        </div>
      ) : (
        groups.map((g) => (
          <div className="picker__group" key={g.type} role="group" aria-label={g.label}>
            <div className="picker__group-label">{g.label}</div>
            <div className="picker__chips">
              {g.accounts.map((a) => (
                <label className="chip" key={a.id}>
                  <input
                    type="radio"
                    className="sr-only"
                    name={name}
                    value={a.id}
                    checked={value === a.id}
                    onChange={() => onChange(a.id)}
                  />
                  <span className="chip__check" aria-hidden="true">
                    <Icon name="check" size={14} />
                  </span>
                  <span className="chip__text">{a.name}</span>
                </label>
              ))}
            </div>
          </div>
        ))
      )}

      {error ? (
        <span className="field__error" id={errId} role="alert">
          <Icon name="alert" size={14} />
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}
