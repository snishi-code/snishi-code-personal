/*
 * フォーム部品。label と control を useId で結びつけ、
 * Testing Library の getByLabelText で参照できるようにする。
 * エラーは色 + アイコン + 文言で示す（色のみに依存しない）。
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export function FieldShell({
  id,
  label,
  required,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {required ? (
          <span className="field__req" aria-hidden="true">
            （必須）
          </span>
        ) : null}
      </label>
      {children}
      {hint ? (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="field__error" id={errId} role="alert">
          <Icon name="close" size={14} />
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface BaseProps {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  dataUi?: string;
}

export function TextInput({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
  hint,
  error,
  dataUi,
  inputMode,
}: BaseProps & {
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'date' | 'number';
  placeholder?: string;
  inputMode?: 'numeric';
}) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} required={required} hint={hint} error={error}>
      <input
        id={id}
        className="input"
        type={type}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
        data-ui={dataUi}
      />
    </FieldShell>
  );
}

export interface Option {
  value: string;
  label: string;
}
export interface OptionGroup {
  label: string;
  options: Option[];
}

export function SelectInput({
  label,
  value,
  onChange,
  options,
  groups,
  required,
  hint,
  error,
  dataUi,
  placeholder,
  disabled,
}: BaseProps & {
  value: string;
  onChange: (v: string) => void;
  options?: Option[];
  groups?: OptionGroup[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} required={required} hint={hint} error={error}>
      <select
        id={id}
        className="select"
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
        data-ui={dataUi}
      >
        {placeholder !== undefined ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {groups?.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </FieldShell>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  required,
  hint,
  error,
  dataUi,
  placeholder,
}: BaseProps & {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} required={required} hint={hint} error={error}>
      <textarea
        id={id}
        className="textarea"
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
        data-ui={dataUi}
      />
    </FieldShell>
  );
}
