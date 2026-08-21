/*
 * 定期ルールの共有フィールド部品（v13.15 §2.2）。
 * ④ルール登録シート（RecurringRuleSheet）と支出シートの rule ページ（EntryRuleStep）が
 * 同じ実装を使う — 二重実装しない。並び順は呼び出し側が決める（v13.1 の作者確定順と
 * モックの rule ページで並びが違うため、フィールド単位で共有する）。
 */
import { TextInput } from '@snishi/foundation/ui/Field';
import { MAX_LEDGER_DATE, MIN_LEDGER_DATE } from '../../domain/calendar';
import { t } from '../../i18n';

/** 周期（everyMonths）の欄。値は数字文字列（呼び出し側が parse・検証する）。 */
export function RuleEveryMonthsField({
  value,
  onChange,
  disabled,
  hint,
  dataUi,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  hint?: string;
  dataUi: string;
}) {
  return (
    <TextInput
      label={t('recurring.intervalMonths')}
      required
      disabled={disabled}
      inputMode="numeric"
      value={value}
      onChange={(v) => onChange(v.replace(/[^\d]/g, ''))}
      {...(hint !== undefined ? { hint } : {})}
      dataUi={dataUi}
    />
  );
}

/** 初回の起票日の欄。 */
export function RulePostingDateField({
  value,
  onChange,
  disabled,
  hint,
  dataUi,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  hint?: string;
  dataUi: string;
}) {
  return (
    <TextInput
      label={t('recurring.firstPostingDate')}
      type="date"
      required
      disabled={disabled}
      value={value}
      min={MIN_LEDGER_DATE}
      max={MAX_LEDGER_DATE}
      onChange={onChange}
      {...(hint !== undefined ? { hint } : {})}
      dataUi={dataUi}
    />
  );
}
