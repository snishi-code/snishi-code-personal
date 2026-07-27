import { monthOf } from './allocation';
import { entriesWithContinuousCost } from './continuousCost';
import { recurringProjectionEntries } from './recurring';
import type { Ledger, JournalEntry } from './types';
import { todayLocal } from '../util/time';

type ReportEntrySource = Pick<
  Ledger,
  'accounts' | 'journalEntries' | 'monthlyCostItems' | 'recurringRules'
>;

/**
 * 選択した基準日時点の集計に使う導出仕訳。
 * 実仕訳に、継続コストと未起票の定期ルールを仮想展開する。仮想行は保存・exportしない。
 */
export function reportEntriesForAsOf(
  ledger: ReportEntrySource,
  asOf: string,
  today: string = todayLocal(),
): JournalEntry[] {
  // 過去表示は「今日までに確定した実使用期間」で再配分し、未来表示は選択時点まで投影する。
  const knowledgeDate = asOf > today ? asOf : today;
  const realThroughAsOf = ledger.journalEntries.filter((entry) => entry.date <= asOf);
  const withContinuousCost = entriesWithContinuousCost(
    realThroughAsOf,
    ledger.monthlyCostItems,
    ledger.accounts,
    asOf,
    monthOf(knowledgeDate),
  );
  return [
    ...withContinuousCost,
    ...recurringProjectionEntries(ledger.recurringRules, ledger.accounts, asOf),
  ];
}
