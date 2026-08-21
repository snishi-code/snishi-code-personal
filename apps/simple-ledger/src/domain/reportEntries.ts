import {
  adjustmentPinExpectedBalance,
  adjustmentSpread,
  isAdjustmentEntry,
  lastAdjustmentAnchors,
  type AdjustmentPinProbe,
} from './adjustmentSpread';
import { continuousCostEntries, CONTINUOUS_COST_HARD_CAP } from './continuousCost';
import {
  investmentProjectionResult,
  type InvestmentProjectionTruncation,
} from './investmentProjection';
import { isLoanItem, loanRepaymentEntries } from './loan';
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
  /**
   * 按分できず stored のまま集計へ戻した補正 pin（完全整合性を欠く破損データ・監査 H）。
   * これは**復旧処理**なので、画面は黙って通常表示に混ぜず「復旧表示」と名乗る。
   */
  unspreadAdjustments: JournalEntry[];
}

/** 全地平ぶんの導出（キャッシュの中身・断面はここから切り出す）。 */
interface FullDerivation {
  /** 導出行（合流順のまま。公開面へ出す側がソートする）。 */
  entries: JournalEntry[];
  /** 全地平ぶんの打ち切り診断（断面ごとに `truncationVisibleAt` で切る）。 */
  truncations: InvestmentProjectionTruncation[];
  /** この導出が実際に展開した最遠日（= max(要求 asOf, 補正の最遠日)）。 */
  horizon: string;
  /** 補正（pin）の最遠日。`opening` 打ち切りが見え始める断面の判定に使う。 */
  maxAdjustmentDate: string | undefined;
  /** 按分できず stored のまま戻した補正 pin（断面では日付で切って見せる）。 */
  unspreadAdjustments: JournalEntry[];
}

/**
 * ledger 1 つにつき 1 回だけ行う全地平導出のキャッシュ。
 *
 * キーは ledger オブジェクトの**同一性**。state/store（`LedgerProvider`）は変更のたびに
 * `repo.loadLedger()` の戻り値で丸ごと差し替えるだけで、既存の ledger を in-place で
 * 書き換えない（`setLedger(next)` = 新しいオブジェクト）。だから「同じオブジェクト =
 * 同じ内容」が成り立つ。WeakMap なので古い ledger は参照が切れれば回収される。
 *
 * 一時的に組み立てた source（repository の保存検証・補正シートの「自分を除いた世界」）は
 * 毎回別オブジェクトなので必ずミスする = 従来どおりその場で導出する（正しさは変わらない）。
 */
const derivationCache = new WeakMap<ReportEntrySource, FullDerivation>();

/** 日付昇順（同日は安定 = 元の合流順を保つ）。 */
function byDate(a: JournalEntry, b: JournalEntry): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

/**
 * `date <= asOf` の prefix の長さ（日付昇順配列の上界を二分探索）。
 * 過去断面の決定性（asOf を動かしても過去の行は変わらない）があるから、断面の切り替えが
 * 「導出し直し」ではなく「配列を切る」で済む。
 */
function prefixLengthForAsOf(entries: readonly JournalEntry[], asOf: string): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid]!.date <= asOf) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * その打ち切りが asOf の断面で見えるか（直接導出と 1 件も違わないための判定）。
 *
 *  - `step`: 刻みが `min(asOf, 2100, 終了点)` を越えたら生成自体が始まらない = `date <= asOf`。
 *  - `opening`: 刻みへ入る前の畳み込みなので、その科目に触れる行が**展開地平**
 *    （= max(asOf, 補正の最遠日)）に現れた時点で見える。補正が先にあると asOf より
 *    先まで展開されるため、asOf だけで切ると直接導出と食い違う。
 */
function truncationVisibleAt(
  truncation: InvestmentProjectionTruncation,
  asOf: string,
  maxAdjustmentDate: string | undefined,
): boolean {
  if (truncation.at === 'step') return truncation.date <= asOf;
  const horizon =
    maxAdjustmentDate !== undefined && maxAdjustmentDate > asOf ? maxAdjustmentDate : asOf;
  return truncation.date <= horizon;
}

/**
 * キャッシュに載せる行を凍結する（v13.8 監査・機構 2-2）。
 * キャッシュは ledger の寿命じゅう全断面へ配られる共有物なので、消費側のうっかり書き換えは
 * 「以後の全断面が静かに汚染される」事故になる。strict mode では書き換えが TypeError で
 * 即座に落ちる = fail-fast（黙って汚染されるより早く割れる方を選ぶ）。
 */
function freezeEntry(entry: JournalEntry): void {
  for (const line of entry.lines) Object.freeze(line);
  Object.freeze(entry.lines);
  if (entry.metadata !== undefined) {
    if (entry.metadata.adjustment !== undefined) Object.freeze(entry.metadata.adjustment);
    Object.freeze(entry.metadata);
  }
  Object.freeze(entry);
}

/**
 * 全地平（`CONTINUOUS_COST_HARD_CAP`）まで 1 回導出して日付昇順に並べたもの。
 * 同じ ledger オブジェクトで 2 回目以降はここを使い回す。
 */
function cachedDerivation(ledger: ReportEntrySource): FullDerivation {
  const hit = derivationCache.get(ledger);
  if (hit) return hit;
  const full = deriveAll(ledger, CONTINUOUS_COST_HARD_CAP);
  // sort は stable なので、同日の中では合流順（実仕訳 → 継続コスト → ルール導出 →
  // 按分スライス → 利回り）がそのまま残る。
  full.entries.sort(byDate);
  for (const entry of full.entries) freezeEntry(entry);
  for (const entry of full.unspreadAdjustments) freezeEntry(entry);
  for (const truncation of full.truncations) Object.freeze(truncation);
  Object.freeze(full.entries);
  Object.freeze(full.unspreadAdjustments);
  Object.freeze(full.truncations);
  derivationCache.set(ledger, full);
  return full;
}

/**
 * 選択した基準日時点の集計に使う導出仕訳（**単一正本**）と、導出が黙って止まっていないかの診断。
 *
 * 実仕訳に、定期ルールの完全導出（購入行 + item 経由の費用行）・継続コスト資産の費用行・
 * 残高補正の按分スライス・投資の利回り導出を仮想展開する。仮想行は保存・export しない。
 *
 * v13.5 B: 導出は ledger が変わったときだけ全地平（2100）へ 1 回行い、断面（asOf）の
 * 切り替えは日付昇順配列の**二分探索**と打ち切り診断のフィルタだけで済ませる（キャッシュ）。
 * 根拠は下の「時間依存が無い」= 過去断面の決定性で、切り出した結果は直接導出と一致する
 * （`reportEntriesResultForAsOfUncached` との一致をテストで固定している）。
 * 戻り値の行は**日付昇順**（同日は合流順）。
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
  // 地平の外（2100 より先の断面。補正がもっと先にあればそこまで）はキャッシュが覆えない。
  // その場合だけ従来どおりその場で導出する（キャッシュを作り直さない）。
  const cached =
    asOf > CONTINUOUS_COST_HARD_CAP ? derivationCache.get(ledger) : cachedDerivation(ledger);
  if (cached === undefined || asOf > cached.horizon) {
    return reportEntriesResultForAsOfUncached(ledger, asOf);
  }
  return {
    entries: cached.entries.slice(0, prefixLengthForAsOf(cached.entries, asOf)),
    investmentProjectionTruncations: cached.truncations.filter((truncation) =>
      truncationVisibleAt(truncation, asOf, cached.maxAdjustmentDate),
    ),
    unspreadAdjustments: cached.unspreadAdjustments.filter((entry) => entry.date <= asOf),
  };
}

/**
 * キャッシュを通さない直接導出（v13.4 までの経路そのまま）。
 *
 * **キャッシュ切り出しの正しさの基準**として残す（テストが「切り出し === 直接導出」を
 * 固定する）。地平の外の断面を要求されたときの実経路でもある。
 */
export function reportEntriesResultForAsOfUncached(
  ledger: ReportEntrySource,
  asOf: string,
): ReportEntriesResult {
  const full = deriveAll(ledger, asOf);
  return {
    // 公開契約は**日付昇順**（キャッシュ経路と同じ）。合流順のまま返すと、地平外の断面
    // だけ並びが変わり契約が破れる（v13.8 監査・機構 2。sort は stable なので同日の中は
    // 合流順 = キャッシュ経路と同一）。
    entries: full.entries.filter((entry) => entry.date <= asOf).sort(byDate),
    investmentProjectionTruncations: full.truncations,
    unspreadAdjustments: full.unspreadAdjustments.filter((entry) => entry.date <= asOf),
  };
}

/** 按分の素材（補正を除いた集計対象行と、宣言として読む pin 群）。 */
interface DerivedBase {
  /** 実仕訳 + 継続コスト + ルール導出（**補正も利回りも含まない**）。 */
  base: JournalEntry[];
  /** 補正（pin）の stored 仕訳。 */
  adjustments: JournalEntry[];
  horizon: string;
  maxAdjustmentDate: string | undefined;
}

/**
 * 按分・利回りへ入る前の素材を作る。
 * 按分の走査（`adjustmentSpread` / `adjustmentPinExpectedBalance`）が要求する
 * 「補正を除いた集計対象行」の作り方をここ 1 箇所に置く。
 */
function deriveBase(ledger: ReportEntrySource, asOf: string): DerivedBase {
  const real: JournalEntry[] = [];
  const adjustments: JournalEntry[] = [];
  // 補正日が asOf より先にあると、その区間のスライスは asOf 以前にも落ちる。按分を asOf に
  // 依存させない（過去の断面が地平の取り方で変わらない）ため、導出は最も遠い補正日まで
  // 広げる。asOf で切るのは切り出し側（この関数は 1 行も落とさない）。
  let horizon = asOf;
  let maxAdjustmentDate: string | undefined;
  for (const entry of ledger.journalEntries) {
    if (generatedEntryRuleId(entry) !== undefined) continue;
    if (isAdjustmentEntry(entry)) {
      adjustments.push(entry);
      if (entry.date > horizon) horizon = entry.date;
      if (maxAdjustmentDate === undefined || entry.date > maxAdjustmentDate) {
        maxAdjustmentDate = entry.date;
      }
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
    // ローン item（負債版）は台帳を経由しないので月割りエンジンから除き、
    // 第 3 の導出源（返済行）として別途合流させる。
    ...continuousCostEntries(
      reportMonthlyCostItems(ledger, derived.items).filter((item) => !isLoanItem(item)),
      ledger.journalEntries,
      horizon,
    ),
    // ローンの返済行（v13.13）: `借方 負債 / 貸方 返済元` を item の刻みで直接導出する。
    // 一括返済（loanSettlement 仕訳）は実仕訳のまま journalEntries を走査して控除する
    // （回収の振替と同じ流儀）。補正の按分より前に合流するので pin は自動でこの世界を見る。
    ...loanRepaymentEntries(ledger.monthlyCostItems, ledger.journalEntries, horizon),
    ...derived.entries,
  ];
  return { base, adjustments, horizon, maxAdjustmentDate };
}

/**
 * **予定 pin の理論残高**（v13.5 C-3）。補正シートの表示と repository の保存時
 * `expectedBalance` がこの 1 本を共有する。
 *
 * 値の定義は `adjustmentPinExpectedBalance`（= 按分の走査そのもの）。ここは素材
 * （補正を除いた集計対象行 + 既存の pin 群）を揃えるだけで、算定を再実装しない。
 *
 * 編集中の pin は**呼び出し側が `ledger.journalEntries` から除いて**渡し、その id /
 * createdAt を `probe` に載せる（同日に複数ある pin の走査順を保存後と一致させる）。
 */
export function adjustmentPinExpectedBalanceForLedger(
  ledger: ReportEntrySource,
  probe: AdjustmentPinProbe,
): number {
  const { base, adjustments } = deriveBase(ledger, probe.date);
  return adjustmentPinExpectedBalance(ledger.accounts, base, adjustments, probe);
}

/** 導出の本体（切り落とし前）。asOf は展開の要求地平であって、ここでは切らない。 */
function deriveAll(ledger: ReportEntrySource, asOf: string): FullDerivation {
  const { base, adjustments, horizon, maxAdjustmentDate } = deriveBase(ledger, asOf);
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
    entries: [...spreadEntries, ...projection.entries],
    truncations: projection.truncations,
    horizon,
    maxAdjustmentDate,
    unspreadAdjustments: spread.unspread,
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
