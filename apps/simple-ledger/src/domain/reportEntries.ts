import { continuousCostEntries } from './continuousCost';
import {
  investmentProjectionResult,
  type InvestmentProjectionTruncation,
} from './investmentProjection';
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
 *
 * これは**保存不変条件の正本**（科目アーカイブの残高 0・終了残高・残高補正の理論残高）。
 * 投資の利回り投影はここへ合流させない——画面表示は `displayEntriesForAsOf` を使う。
 * 投影行は常に today より未来の日付のみ＝過去断面は today に依存しない。
 */
export function reportEntriesForAsOf(ledger: ReportEntrySource, asOf: string): JournalEntry[] {
  const realThroughAsOf = ledger.journalEntries.filter((entry) => entry.date <= asOf);
  return [
    ...realThroughAsOf,
    // 回収・金額・期間は「現在わかっている全事実」を導出パラメータにする。
    // 表示する実仕訳と仮想行の日付だけを asOf で切るため、後日の回収による再配分は
    // 過去・現在・未来のどの断面でも同じになる。
    ...continuousCostEntries(ledger.monthlyCostItems, ledger.journalEntries, asOf),
    ...recurringProjectionEntries(ledger.recurringRules, ledger.accounts, asOf),
  ];
}

/**
 * **画面表示用**の導出仕訳 = reportEntriesForAsOf + 投資の利回り投影。
 *
 * today は明示引数（domain で Date.now を呼ばない）。投影行は常に today より未来の
 * 月初日にだけ生まれるため、過去断面（asOf <= today）は reportEntriesForAsOf と完全一致する。
 * 保存判断（repository の残高 0 検証・残高補正の理論残高）は reportEntriesForAsOf のまま
 * 変えない——仮の利回りを保存判断へ逆流させない（Codex 指摘・§D 2026-08-11）。
 */
export function displayEntriesForAsOf(
  ledger: ReportEntrySource,
  asOf: string,
  today: string,
): JournalEntry[] {
  return displayEntriesResultForAsOf(ledger, asOf, today).entries;
}

export interface DisplayEntriesResult {
  entries: JournalEntry[];
  /**
   * 算術限界で投影を打ち切った科目。**アプリ都合の端点**なので、これを消費する画面は
   * 「投影を含む」と言い続けず、止まった事実を名乗る（仮の数字が本物の顔をしない）。
   */
  investmentProjectionTruncations: InvestmentProjectionTruncation[];
}

/** `displayEntriesForAsOf` と同じ結果に、投影が黙って止まっていないかの診断を添えて返す。 */
export function displayEntriesResultForAsOf(
  ledger: ReportEntrySource,
  asOf: string,
  today: string,
): DisplayEntriesResult {
  const base = reportEntriesForAsOf(ledger, asOf);
  const projection = investmentProjectionResult(ledger.accounts, base, asOf, today);
  return {
    entries: [...base, ...projection.entries],
    investmentProjectionTruncations: projection.truncations,
  };
}
