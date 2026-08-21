/*
 * 勘定科目のチップピッカー。
 * 既定は単一選択（radio）。`multi` を渡すと複数選択（checkbox・v13.16 諸口）になる —
 * 単一モードの既存呼び出しは無改変のまま（補正・opening・ルール等は単一のまま）。
 * 複数選択の並びは**選択順**を保持する（末尾 = 振り分けページの自動計算枠）。
 */
import { useId, type CSSProperties } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import type { AccountGroup } from './accountOptions';
import type { Account } from '../domain/types';
import { accountAccent } from './accountBoxes';
import { t } from '../i18n';

/** 複数選択モード（v13.16）。values の並び = 選択順（append）。 */
export interface AccountPickerMulti {
  values: readonly string[];
  onValuesChange: (ids: string[]) => void;
}

export function AccountPicker({
  label,
  groups,
  value,
  onChange,
  multi,
  required,
  hint,
  error,
  dataUi,
  emptyText,
  flat,
  disabled,
}: {
  label: string;
  groups: AccountGroup[];
  /** 単一選択の値。multi 指定時は無視される。 */
  value?: string;
  onChange?: (id: string) => void;
  /** 複数選択モード。指定時は checkbox になり value/onChange は使わない。 */
  multi?: AccountPickerMulti;
  required?: boolean;
  hint?: string;
  error?: string;
  dataUi?: string;
  emptyText?: string;
  flat?: boolean;
  /** 全候補を選択不可にする（編集ロック時。fieldset の native disabled で入力ごと止める）。 */
  disabled?: boolean;
}) {
  const name = useId();
  const errId = `${name}-err`;
  const isEmpty = groups.length === 0;
  const flatAccounts = flat ? groups.flatMap((g) => g.accounts) : [];

  const isSelected = (id: string): boolean =>
    multi !== undefined ? multi.values.includes(id) : value === id;
  const select = (id: string): void => {
    if (multi === undefined) {
      onChange?.(id);
      return;
    }
    // 選択順を保持して末尾へ足す / 外す（並びが振り分けページの枠順になる）。
    multi.onValuesChange(
      multi.values.includes(id) ? multi.values.filter((v) => v !== id) : [...multi.values, id],
    );
  };
  const chip = (a: Account) => (
    <label className="chip" key={a.id}>
      <input
        type={multi !== undefined ? 'checkbox' : 'radio'}
        className="sr-only"
        name={name}
        value={a.id}
        checked={isSelected(a.id)}
        onChange={() => select(a.id)}
      />
      <span className="chip__check" aria-hidden="true">
        <Icon name="check" size={14} />
      </span>
      <span className="chip__text">{a.name}</span>
    </label>
  );

  return (
    <fieldset
      className="field picker"
      disabled={disabled}
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
        <div className="picker__chips">{flatAccounts.map(chip)}</div>
      ) : (
        groups.map((g) => (
          <div
            className="picker__group"
            key={g.type}
            role="group"
            aria-label={g.label}
            style={
              g.accounts[0]
                ? ({ '--account-accent': accountAccent(g.accounts[0]) } as CSSProperties)
                : undefined
            }
          >
            <div className="picker__group-label">{g.label}</div>
            <div className="picker__chips">{g.accounts.map(chip)}</div>
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
