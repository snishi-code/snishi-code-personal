import { adjustmentSpread, isAdjustmentEntry, lastAdjustmentAnchors } from './adjustmentSpread';
import { continuousCostEntries } from './continuousCost';
import {
  investmentProjectionResult,
  type InvestmentProjectionTruncation,
} from './investmentProjection';
import { deriveRecurringOutputs, generatedEntryRuleId, generatedItemRuleId } from './recurring';
import type { Ledger, JournalEntry, MonthlyCostItem } from './types';

type ReportEntrySource = Pick<
  Ledger,
  'accounts' | 'journalEntries' | 'monthlyCostItems' | 'recurringRules'
>;

export interface ReportEntriesResult {
  entries: JournalEntry[];
  /**
   * 算術限界で利回り導出を打ち切った科目。**アプリ都合の端点**なので、これを消費する画面は
   * 「導出を含む」と言い続けず、止まった事実を名乗る（数字が黙って横ばいの顔をしない）。
   */
  investmentProjectionTruncations: InvestmentProjectionTruncation[];
}

/**
 * 選択した基準日時点の集計に使う導出仕訳（**単一正本**）と、導出が黙って止まっていないかの診断。
 *
 * 実仕訳に、定期ルールの完全導出（購入行 + item 経由の費用行）・継続コスト資産の費用行・
 * 残高補正の按分スライス・投資の利回り導出を仮想展開する。仮想行は保存・export しない。
 *
 * v13: ルール由来（rec- 仕訳・ccr- item）は保存せず、ルール線分から毎回導出する。
 * 保存データに残っていても読まない（半移行状態の fail-closed 防御。二重計上を防ぐ）。
 *
 * v13.4 ①: 残高補正（metadata.adjustment）の stored 仕訳は**集計に入れない**。宣言（pin）として
 * 読み、直前の補正との区間へ月割りした按分スライスへ置き換える（adjustmentSpread.ts が正本）。
 * 補正日以降の残高は置き換え前と完全に一致する。
 *
 * v13.4 ②: 投資の利回り導出も**ここへ合流する**（作者決定 2026-08-17）。利回りは「仮の数字」
 * ではなく作者の**宣言**なので、表示専用にせず保存不変条件（科目アーカイブの残高 0・終了残高・
 * 残高補正の理論残高）にも載せる。§D（2026-08-11）の「仮の投影を保存判断へ逆流させない」は
 * 意識的に逆転した。起点は最後の補正（pin）で、pin より手前は按分が支配する
 * （investmentProjection.ts が正本）。
 *
 * 時間依存（today / knowledgeDate）は無い: 展開はすべて保存データ（宣言された日付）だけで
 * 決まり、asOf を動かしても展開範囲が変わるだけで過去の値は変わらない。
 */
export function reportEntriesResultForAsOf(
  ledger: ReportEntrySource,
  asOf: string,
): ReportEntriesResult {
  const real: JournalEntry[] = [];
  const adjustments: JournalEntry[] = [];
  // 補正日が asOf より先にあると、その区間のスライスは asOf 以前にも落ちる。按分を asOf に
  // 依存させない（過去の断面が地平の取り方で変わらない）ため、導出は最も遠い補正日まで
  // 広げてから最後に asOf で切る。補正が無い / すべて過去なら従来と同じ展開量になる。
  let horizon = asOf;
  for (const entry of ledger.journalEntries) {
    if (generatedEntryRuleId(entry) !== undefined) continue;
    if (isAdjustmentEntry(entry)) {
      adjustments.push(entry);
      if (entry.date > horizon) horizon = entry.date;
    } else {
      real.push(entry);
    }
  }
  const derived = deriveRecurringOutputs(ledger.recurringRules, ledger.accounts, horizon);
  const base = [
    ...real.filter((entry) => entry.date <= horizon),
    // 回収・金額・期間は「現在わかっている全事実」を導出パラメータにする。
    // 表示する実仕訳と仮想行の日付だけを asOf で切るため、後日の回収による再配分は
    // 過去・現在・未来のどの断面でも同じになる。回収の振替は実仕訳のまま
    // journalEntries を走査する（導出 item も決定的 ID で同じ回収に到達する）。
    ...continuousCostEntries(
      reportMonthlyCostItems(ledger, derived.items),
      ledger.journalEntries,
      horizon,
    ),
    ...derived.entries,
  ];
  const spread = adjustmentSpread(ledger.accounts, base, adjustments);
  const spreadEntries = [...base, ...spread.entries, ...spread.unspread];
  // 利回りは按分の**後**に積む: 生成されるのは最後の pin より後だけなので、按分が支配する
  // 区間（pin どうしの間）へは決して入り込まない = 差額 G の算定と循環しない。
  const projection = investmentProjectionResult(
    ledger.accounts,
    spreadEntries,
    lastAdjustmentAnchors(ledger.accounts, adjustments),
    asOf,
  );
  return {
    entries: [...spreadEntries, ...projection.entries].filter((entry) => entry.date <= asOf),
    investmentProjectionTruncations: projection.truncations,
  };
}

/** 行だけが要る呼び出し向けの薄い入口（打ち切りは `reportEntriesResultForAsOf` で見る）。 */
export function reportEntriesForAsOf(ledger: ReportEntrySource, asOf: string): JournalEntry[] {
  return reportEntriesResultForAsOf(ledger, asOf).entries;
}

/**
 * 集計・一覧が見る item の集合 = 手動 item + ルールから導出した item。
 * 保存データに残った ccr-（v12 以前の実体化の名残）は読まない（導出と二重になるため）。
 */
export function reportMonthlyCostItems(
  ledger: Pick<Ledger, 'monthlyCostItems'>,
  derivedItems: MonthlyCostItem[],
): MonthlyCostItem[] {
  const manual = ledger.monthlyCostItems.filter((item) => generatedItemRuleId(item) === undefined);
  return [...manual, ...derivedItems];
}

/* ── 「画面表示用」の入口 ──
 * v13.4 ② で**保存境界とまったく同じもの**になった（利回り導出が合流したため、
 * 「表示専用の投影」という区別自体が消えた）。画面側の呼び名として別名だけ残す。
 */

export type DisplayEntriesResult = ReportEntriesResult;

/** `reportEntriesForAsOf` の別名（画面から呼ぶときの名前）。 */
export function displayEntriesForAsOf(ledger: ReportEntrySource, asOf: string): JournalEntry[] {
  return reportEntriesForAsOf(ledger, asOf);
}

/** `reportEntriesResultForAsOf` の別名（画面から呼ぶときの名前）。 */
export function displayEntriesResultForAsOf(
  ledger: ReportEntrySource,
  asOf: string,
): DisplayEntriesResult {
  return reportEntriesResultForAsOf(ledger, asOf);
}
