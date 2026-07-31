import { continuousCostEntries } from './continuousCost';
import { recurringProjectionEntries } from './recurring';
import type { Ledger, JournalEntry } from './types';

type ReportEntrySource = Pick<
  Ledger,
  'accounts' | 'journalEntries' | 'monthlyCostItems' | 'recurringRules'
>;

/**
 * 選択した基準日時点の集計に使う導出仕訳。
 * 実仕訳に、継続コスト資産の費用行と未起票の定期ルール（購入行 + 費用行）を仮想展開する。
 * 仮想行は保存・export しない。
 *
 * 時間依存（today / knowledgeDate）は無い: 配分は「ユーザーが明示した終了日」だけで決まり、
 * asOf を動かしても展開範囲が変わるだけで過去の値は変わらない。
 */
export function reportEntriesForAsOf(ledger: ReportEntrySource, asOf: string): JournalEntry[] {
  const realThroughAsOf = ledger.journalEntries.filter((entry) => entry.date <= asOf);
  return [
    ...realThroughAsOf,
    // 回収・金額・期間は「現在わかっている全事実」を導出パラメータにする。
    // 表示する実仕訳と仮想行の日付だけを asOf で切るため、後日の回収による再配分は
    // 過去・現在・未来のどの断面でも同じになる。
    ...continuousCostEntries(ledger.monthlyCostItems, ledger.journalEntries, asOf),
    ...recurringProjectionEntries(
      ledger.recurringRules,
      ledger.accounts,
      asOf,
      ledger.monthlyCostItems,
    ),
  ];
}
