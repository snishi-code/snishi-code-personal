/*
 * 仕訳シートの「振り分け」ページ部品（v13.16 諸口）。
 * 複数選択した科目ごとの金額入力欄。**最後の 1 枠は入力欄でなく自動計算の表示**
 * （合計 − 他の枠の和。左右一致を機械保証 = 「入力補助まで」の範囲）。
 * 自動枠が負・0 になる入力はエラー表示で保存不可（0 円の行は作らない — 枠を減らすのが正）。
 * state は EntrySheet が持ち、ここは表示と入力の受け渡しだけ。
 */
import { TextInput } from '@snishi/foundation/ui/Field';
import { moneyText } from '../money';
import { StepSummaryCard } from './StepSummaryCard';
import type { Account } from '../../domain/types';
import type { FractionDigits } from '../../util/format';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

export function EntrySplitStep({
  accounts,
  currency,
  fractionDigits,
  total,
  ids,
  texts,
  autoAmount,
  amountsInvalid,
  autoInvalid,
  onTextChange,
}: {
  accounts: Account[];
  currency: string;
  fractionDigits: FractionDigits;
  /** 振り分ける合計（1 ページ目の金額欄の値）。 */
  total: number;
  /** 複数選択した科目 ID（選択順。末尾 = 自動計算枠）。 */
  ids: readonly string[];
  /** 手入力枠（末尾以外）のテキスト。キー = 科目 ID。 */
  texts: Readonly<Record<string, string>>;
  /** 自動計算枠の額（合計 − Σ手入力。親で計算済み）。 */
  autoAmount: number;
  /** 手入力枠に 1 未満・不正がある（保存試行後に立つ）。 */
  amountsInvalid: boolean;
  /** 自動枠が 0 以下（保存試行後に立つ）。 */
  autoInvalid: boolean;
  onTextChange: (id: string, v: string) => void;
}) {
  const nameOf = (id: string): string => accounts.find((a) => a.id === id)?.name ?? '—';
  const manualIds = ids.slice(0, -1);
  const autoId = ids[ids.length - 1];
  return (
    <div className="stack" data-ui={UI.journal.entry.splitPanel}>
      {manualIds.map((id) => (
        <TextInput
          key={id}
          label={nameOf(id)}
          required
          inputMode={fractionDigits === 0 ? 'numeric' : 'decimal'}
          value={texts[id] ?? ''}
          onChange={(v) => onTextChange(id, v)}
          error={amountsInvalid ? t('entry.splitAmountInvalid') : undefined}
          dataUi={UI.journal.entry.splitAmount}
        />
      ))}
      {autoId !== undefined ? (
        // 最後の枠は自動計算の表示（入力欄にしない = 左右一致の機械保証）。
        <div className="field" data-ui={UI.journal.entry.splitAuto}>
          <span className="field__label">{nameOf(autoId)}</span>
          <div className="list__title">{moneyText(autoAmount, currency, fractionDigits)}</div>
          <span className="field__hint">{t('entry.splitAutoHint')}</span>
          {autoInvalid ? (
            <span className="field__error" role="alert">
              {t('entry.splitAutoInvalid')}
            </span>
          ) : null}
        </div>
      ) : null}
      <StepSummaryCard
        label={t('entry.splitTotal')}
        value={moneyText(total, currency, fractionDigits)}
        note={t('entry.splitTotalNote', { count: ids.length })}
        dataUi={UI.journal.entry.splitPreview}
      />
    </div>
  );
}
