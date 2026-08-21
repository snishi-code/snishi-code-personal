/*
 * 仕訳シートの「ルールの入力」ページ部品（v13.15 §2.2・4 ページ目）。
 * 聞くのは周期（everyMonths）と初回の起票日だけ — 摘要・金額・計上先・源泉は base から
 * 流用する（写像は全モード単一規則: 計上先 = base の借方 / 源泉 = base の貸方）。
 * フィールドの実装は RuleFields を RecurringRuleSheet と共有し、並びはモック正本
 * （周期 → 起票日 → まとめカード）。state は EntrySheet が持つ。
 */
import { RuleEveryMonthsField, RulePostingDateField } from './RuleFields';
import { StepSummaryCard } from './StepSummaryCard';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

export function EntryRuleStep({
  everyText,
  postingDate,
  everyError,
  postingDateError,
  summary,
  onEveryTextChange,
  onPostingDateChange,
  onDisable,
}: {
  everyText: string;
  /** 初回の起票日（既定 = base の日付。ページ進入時に EntrySheet が流し込む）。 */
  postingDate: string;
  everyError: boolean;
  postingDateError: boolean;
  /** 下部まとめカード（入力が有効な間だけ）。sentence = このルールがやることの一文。 */
  summary: { firstPostingDate: string; sentence: string } | null;
  onEveryTextChange: (v: string) => void;
  onPostingDateChange: (v: string) => void;
  /** 「ルールをやめる」（選択解除 + 1 ページ目へ戻る）。 */
  onDisable: () => void;
}) {
  const every = Number.parseInt(everyText, 10);
  // 年単位の周期は言い換えのヒントを添える（モックの「= 10 年ごとに買い替え」）。
  const yearsHint =
    Number.isInteger(every) && every >= 12 && every % 12 === 0
      ? t('entry.ruleEveryYearsHint', { years: every / 12 })
      : undefined;
  return (
    <>
      <RuleEveryMonthsField
        value={everyText}
        onChange={onEveryTextChange}
        {...(yearsHint !== undefined ? { hint: yearsHint } : {})}
        dataUi={UI.journal.entry.ruleEvery}
      />
      {everyError ? (
        <p className="field__error" role="alert">
          {t('error.recurring.everyMonthsInvalid')}
        </p>
      ) : null}
      <RulePostingDateField
        value={postingDate}
        onChange={onPostingDateChange}
        hint={t('entry.rulePostingDateHint')}
        dataUi={UI.journal.entry.rulePostingDate}
      />
      {postingDateError ? (
        <p className="field__error" role="alert">
          {t('error.recurring.dayOfMonthInvalid')}
        </p>
      ) : null}
      <button
        type="button"
        className="collapse-toggle"
        onClick={onDisable}
        data-ui={UI.journal.entry.ruleToggleBack}
      >
        {t('entry.ruleBack')}
      </button>
      {summary !== null ? (
        <StepSummaryCard
          label={t('recurring.firstPosting')}
          value={summary.firstPostingDate}
          note={summary.sentence}
          dataUi={UI.journal.entry.rulePreview}
        />
      ) : null}
    </>
  );
}
