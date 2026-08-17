/*
 * 投資の利回り導出（v13.4 ②・作者決定 2026-08-17）。
 *
 * 想定利回り（Account.annualReturnBp・年率 bp）を**宣言**した投資科目について、毎月
 * 「計上先（収入科目・ユーザー選択）→ 投資」の評価益を導出仕訳として生成する。
 * 継続コスト（割り算）と対になる**掛け算**: 月利 = (1 + bp/10000)^(1/12) − 1。
 *
 * §D（2026-08-11）の「today 起点・表示専用」からの**意識的な転換**:
 *  - **起点 = 最後の残高補正（pin）**。補正が無ければ科目の実効開始（その科目に触れる
 *    最初の集計対象行の日）から 0 + フローで積む。today はもう受け取らない——
 *    「たまたまアプリを開いた日」が導出結果の意味を変えない（時計に依存しない）。
 *  - **補正で挟まれた区間には関与しない**。そこは按分（adjustmentSpread.ts）が支配する。
 *    利回りが効くのは最後の pin より後だけなので、**利回りをいつ変えても pin 区間の
 *    過去は 1 円も動かない**。宣言を変えたら未来だけが動く。
 *  - **保存境界（`reportEntriesForAsOf`）へ合流する**。利回りは「仮の数字」ではなく作者の
 *    宣言なので、補正の理論残高・終了点の残高 0 検証にも導出益が入る（§D の
 *    「仮の数字を保存判断へ逆流させない」を作者判断で逆転した）。
 *  - **終了（endDate）を宣言した科目も存在期間内は導出する**。終了時に残高を振替で移すのは
 *    作者の仕事であって、アプリが黙って利回りを止めることではない。終了点不明の旧
 *    アーカイブ科目（archived かつ endDate なし）だけは導出しない（端点を推測しない）。
 *
 * 計算規約:
 *  - 刻み: k 番目 = addMonthsToDate(anchor, k)（月割り台帳・按分と同じ同日刻み）。各刻みで
 *    直前の刻み以降のフロー（実仕訳・継続コスト・ルール導出・按分スライス）を残高へ
 *    織り込んでから複利を掛ける。
 *  - 評価益は各月 1 minor（= 1/100 単位）へ丸め（Math.round・決定的）。
 *    0 の月・残高 0 以下の月は行を生成しない。
 *    負利回り（元本減）は逆向き（借方 計上先 / 貸方 投資）。
 *  - 上限: min(要求 asOf, 科目の終了点, CONTINUOUS_COST_HARD_CAP（2100））。いずれも作者へ
 *    宣言済みの端点（地平セレクタ・date input の max・終了宣言）なので、黙って止まっても
 *    嘘にならない。
 *  - 算術限界（IEEE754 の安全整数域）で計算を諦めた科目は**戻り値で名乗る**
 *    （`InvestmentProjectionResult.truncations`）。行が無いことの意味を「対象外」「0 円」
 *    「計算できなくなった」の 3 つに畳まない＝アプリ都合の端点を隠さない。
 *  - 生成した行は保存されない導出専用（metadata.virtual + investmentProjectionOf）。
 *    実仕訳・export には決して入らない。
 *  - fail-closed: 計上先（projectionAccountId）が存在しない・income-category でない・
 *    自分自身のとき、その科目の導出は生成しない（保存は壊さない）。
 */
import { addMonthsToDate, monthOf } from './allocation';
import { accountExistsAt } from './accountLifetime';
import { CONTINUOUS_COST_HARD_CAP } from './continuousCost';
import { t } from '../i18n';
import type { AdjustmentAnchor } from './adjustmentSpread';
import type { Account, JournalEntry } from './types';
import { assertSafeAmount } from './safeSum';

/** 想定利回り（年率 bp）の範囲。schema / 保存境界 / UI 変換が同じ正本を参照する。 */
export const ANNUAL_RETURN_BP_MIN = -9999;
export const ANNUAL_RETURN_BP_MAX = 100_000;

/** 桁あふれガード（残高がこの値を超えたらその科目の生成を停止する）。 */
const PROJECTION_BALANCE_LIMIT = Number.MAX_SAFE_INTEGER / 2;

/**
 * 算術限界で投影を打ち切った科目。`month` 以降の行は生成していない。
 * これは作者が宣言した端点ではなく**アプリ都合の端点**なので、画面はこれを名乗る。
 */
export interface InvestmentProjectionTruncation {
  accountId: string;
  /** 生成できなくなった最初の月（`YYYY-MM`）。 */
  month: string;
}

/** 投影の生成結果。行と、アプリ都合で止まった事実を分けて返す。 */
export interface InvestmentProjectionResult {
  entries: JournalEntry[];
  truncations: InvestmentProjectionTruncation[];
}

/** 月利 = (1 + bp/10000)^(1/12) − 1。中間計算の浮動小数は許容（保存されない導出行）。 */
export function monthlyReturnRate(annualReturnBp: number): number {
  return Math.pow(1 + annualReturnBp / 10_000, 1 / 12) - 1;
}

/** 有効な利回り宣言。月利と計上先が揃って初めて導出できる。 */
export interface InvestmentReturnDeclaration {
  /** 月利 = (1 + bp/10000)^(1/12) − 1。 */
  rate: number;
  /** 評価損益の計上先（income-category）。 */
  projectionAccountId: string;
  projectionAccount: Account;
}

/**
 * その科目が「利回りを宣言した投資科目」か（**宣言の有効性判定の単一正本**）。
 * 利回り導出（investmentProjectionResult）と残高補正の按分の計上先解決が共有する。
 *
 * fail-closed: investment-asset でない・bp が未設定/0/非整数/範囲外・計上先が欠落/
 * 自分自身/存在しない/income-category でない、のいずれかなら宣言は無い（undefined）。
 */
export function investmentReturnDeclaration(
  account: Account,
  byId: ReadonlyMap<string, Account>,
): InvestmentReturnDeclaration | undefined {
  if (account.role !== 'investment-asset') return undefined;
  const bp = account.annualReturnBp;
  if (bp === undefined || bp === 0 || !Number.isInteger(bp)) return undefined;
  if (bp < ANNUAL_RETURN_BP_MIN || bp > ANNUAL_RETURN_BP_MAX) return undefined;
  const projectionAccountId = account.projectionAccountId;
  if (projectionAccountId === undefined || projectionAccountId === account.id) return undefined;
  const projectionAccount = byId.get(projectionAccountId);
  if (!projectionAccount || projectionAccount.role !== 'income-category') return undefined;
  const rate = monthlyReturnRate(bp);
  if (!Number.isFinite(rate) || rate === 0) return undefined;
  return { rate, projectionAccountId, projectionAccount };
}

/** 投影行の決定的 ID。 */
function projectionEntryId(accountId: string, month: string): string {
  return `inv-proj-${accountId}-${month}`;
}

/** その科目の行の自然増減（投資 = 資産なので借方が正）。 */
function balanceDelta(entry: JournalEntry, accountId: string): number {
  let delta = 0;
  for (const line of entry.lines) {
    if (line.accountId !== accountId) continue;
    delta = assertSafeAmount(delta + (line.side === 'debit' ? line.amount : -line.amount));
  }
  return delta;
}

/** 日付昇順（走査用。同日どうしの順序は残高の推移に影響しない）。 */
function byDate(a: { date: string }, b: { date: string }): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

/**
 * 全対象科目の利回り導出行と、算術限界で打ち切った科目を返す。
 *
 * `derivedEntries` = 利回り以外の集計対象行（実仕訳 + 継続コスト + ルール導出 + 按分スライス）。
 * `anchors` = 科目ごとの最後の宣言（`lastAdjustmentAnchors`）。無い科目は実効開始から積む。
 *
 * 決定性: 起点も刻みも保存データだけで決まるため、`asOf` を動かしても既に生まれた行は
 * 1 行も変わらない（地平を伸ばすと先が増えるだけ）。today は受け取らない。
 */
export function investmentProjectionResult(
  accounts: readonly Account[],
  derivedEntries: readonly JournalEntry[],
  anchors: ReadonlyMap<string, AdjustmentAnchor>,
  asOf: string,
): InvestmentProjectionResult {
  const byId = new Map(accounts.map((account) => [account.id, account] as const));
  const horizon = asOf < CONTINUOUS_COST_HARD_CAP ? asOf : CONTINUOUS_COST_HARD_CAP;
  const out: JournalEntry[] = [];
  const truncations: InvestmentProjectionTruncation[] = [];

  for (const account of accounts) {
    // 対象: 利回りを宣言した investment-asset（未設定/0/計上先不正 = 導出なし）。
    const declaration = investmentReturnDeclaration(account, byId);
    if (declaration === undefined) continue;
    // 終了点不明の旧アーカイブ科目だけは導出しない（どこまで存在したか決まらない）。
    if (account.archived && account.endDate === undefined) continue;
    const { rate, projectionAccountId, projectionAccount } = declaration;
    // 上限 = min(要求 asOf, 2100, 科目の終了点)。終了を宣言した科目も存在期間内は導出する。
    const cap =
      account.endDate !== undefined && account.endDate < horizon ? account.endDate : horizon;

    // その科目に触れる集計対象行（実仕訳・継続コスト・ルール導出・按分スライス）。
    const flows = derivedEntries
      .filter((entry) => entry.lines.some((line) => line.accountId === account.id))
      .sort(byDate);
    const anchor = anchors.get(account.id);
    // 起点 = 最後の宣言の日。宣言が無ければ実効開始（触れる行が 1 本も無ければ起点も無い）。
    const anchorDate = anchor?.date ?? flows[0]?.date;
    if (anchorDate === undefined) continue;

    // 起点日までの行は起点残高に畳み込む。宣言があれば実額が正本なので読み飛ばす
    // （按分スライスがその日までに差額を埋めているので、走査しても同じ値になる）。
    let cursor = 0;
    while (cursor < flows.length && flows[cursor]!.date <= anchorDate) cursor += 1;
    let balance = anchor?.actualBalance ?? 0;
    if (anchor === undefined) {
      let openingOverflow = false;
      for (let i = 0; i < cursor; i += 1) {
        try {
          balance = assertSafeAmount(balance + balanceDelta(flows[i]!, account.id));
        } catch {
          truncations.push({ accountId: account.id, month: monthOf(anchorDate) });
          openingOverflow = true;
          break;
        }
      }
      if (openingOverflow) continue;
    }

    // 刻みは anchor 起点の同日刻み（月割り台帳・按分と同じ規約）。
    for (let k = 1; ; k += 1) {
      const date = addMonthsToDate(anchorDate, k);
      if (date > cap) break;
      const month = monthOf(date);
      // 直前の刻み以降・この刻みより前のフロー（積立・引出・ルール導出）を残高へ織り込む。
      let flowOverflow = false;
      while (cursor < flows.length && flows[cursor]!.date < date) {
        try {
          balance = assertSafeAmount(balance + balanceDelta(flows[cursor]!, account.id));
        } catch {
          // 後続の逆向き仕訳で安全域へ戻っても、一度失った整数精度は回復しない。
          // 最初に表現不能になった月から導出を止め、既存の診断経路で明示する。
          truncations.push({ accountId: account.id, month });
          flowOverflow = true;
          break;
        }
        cursor += 1;
      }
      if (flowOverflow) break;
      // 存在期間外（未来開始・計上先の期間外）の断面には行を立てない。
      if (!accountExistsAt(account, date) || !accountExistsAt(projectionAccount, date)) continue;
      if (balance <= 0) continue; // 残高 0 以下には適用しない（生成なし・複利も進めない）
      const gain = Math.round(balance * rate);
      if (gain === 0) continue;
      let next: number;
      try {
        next = assertSafeAmount(balance + gain);
      } catch {
        truncations.push({ accountId: account.id, month });
        break;
      }
      // 桁あふれガード: 超える月からはこの科目の生成を停止する（それ以前の行は維持）。
      // 黙って止めない——アプリ都合の端点として戻り値で名乗る。
      if (Math.abs(next) > PROJECTION_BALANCE_LIMIT) {
        truncations.push({ accountId: account.id, month });
        break;
      }
      const amount = Math.abs(gain);
      out.push({
        id: projectionEntryId(account.id, month),
        date,
        description: t('projection.entryDescription', { name: account.name }),
        kind: 'normal',
        lines:
          gain > 0
            ? [
                { accountId: account.id, side: 'debit', amount },
                { accountId: projectionAccountId, side: 'credit', amount },
              ]
            : [
                { accountId: projectionAccountId, side: 'debit', amount },
                { accountId: account.id, side: 'credit', amount },
              ],
        metadata: { virtual: true, investmentProjectionOf: account.id },
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      });
      balance = next;
    }
  }
  return { entries: out, truncations };
}

/* ── 科目編集 UI の「年率 %」⇄ bp（整数）変換 ── */

/**
 * bp（整数）→ 年率 % の入力テキスト。300 → '3'、325 → '3.25'、-50 → '-0.5'。
 * 浮動小数を経由せず整数演算だけで組み立てる（決定的）。
 */
export function annualReturnBpToPercentText(bp: number): string {
  const sign = bp < 0 ? '-' : '';
  const abs = Math.abs(bp);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  if (frac === 0) return `${sign}${whole}`;
  if (frac % 10 === 0) return `${sign}${whole}.${frac / 10}`;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

/**
 * 年率 % の入力テキスト → bp（整数）。小数第 2 位まで・範囲外や解釈できない入力は null。
 * '3' → 300、'3.25' → 325、'-0.5' → -50。浮動小数を経由しない（'0.29' 等の誤差を作らない）。
 */
export function parseAnnualReturnPercentText(text: string): number | null {
  const match = /^([+-]?)(\d{1,4})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number.parseInt(match[2]!, 10);
  const frac = match[3] === undefined ? 0 : Number.parseInt(match[3].padEnd(2, '0'), 10);
  const bp = sign * (whole * 100 + frac);
  if (bp < ANNUAL_RETURN_BP_MIN || bp > ANNUAL_RETURN_BP_MAX) return null;
  return bp;
}
