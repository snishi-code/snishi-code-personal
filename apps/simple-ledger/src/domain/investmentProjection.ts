/*
 * 投資の利回り投影（表示専用の純計算・§D 2026-08-11）。
 *
 * 想定利回り（Account.annualReturnBp・年率 bp）を設定した投資科目について、毎月
 * 「計上先（収入科目・ユーザー選択）→ 投資」の評価益を仮想仕訳として生成する。
 * 継続コスト（割り算）と対になる**掛け算**: 月利 = (1 + bp/10000)^(1/12) − 1。
 *
 *  - 起点 = today（**明示引数**。ここで Date.now は呼ばない・決定的）。行は常に today より
 *    未来の月初日にだけ生まれる＝過去断面は today に依存しない（構造で保証）。
 *  - 元本 = 渡された導出込み仕訳から算定した today 時点の残高。各月の間にある
 *    その科目の仕訳（未来の積立・引出・ルール投影）を残高へ織り込みながら複利で進める。
 *  - 評価益は各月円へ丸め（Math.round・決定的）。0 円の月・残高 0 以下の月は行を生成しない。
 *    負利回り（元本減）は逆向き（借方 計上先 / 貸方 投資）。
 *  - 上限: 要求 asOf と CONTINUOUS_COST_HARD_CAP（2100）で打ち切り。残高が
 *    Number.MAX_SAFE_INTEGER/2 を超える月はその科目の生成を停止する（それ以前の行は維持）。
 *  - 生成した行は保存されない導出専用（metadata.virtual + investmentProjectionOf）。
 *    `displayEntriesForAsOf` の結果にだけ現れ、保存不変条件（`reportEntriesForAsOf`）へは
 *    決して合流しない（仮の利回りを保存判断へ逆流させない・Codex 指摘）。
 *  - fail-closed: 計上先（projectionAccountId）が存在しない・income-category でない・
 *    自分自身のとき、その科目の投影は生成しない（保存は壊さない）。
 */
import { addMonths, monthOf } from './allocation';
import { accountExistsAt } from './accountLifetime';
import { CONTINUOUS_COST_HARD_CAP } from './continuousCost';
import type { Account, JournalEntry } from './types';

/** 想定利回り（年率 bp）の範囲。schema / 保存境界 / UI 変換が同じ正本を参照する。 */
export const ANNUAL_RETURN_BP_MIN = -9999;
export const ANNUAL_RETURN_BP_MAX = 100_000;

/** 計上先サジェストの既定名（この名前の収入科目があれば選択肢の先頭に出す。自動確定はしない）。 */
export const INVESTMENT_PROJECTION_SUGGESTED_NAME = '投資益' as const;

/** 桁あふれガード（残高がこの値を超えたらその科目の生成を停止する）。 */
const PROJECTION_BALANCE_LIMIT = Number.MAX_SAFE_INTEGER / 2;

/** 月利 = (1 + bp/10000)^(1/12) − 1。中間計算の浮動小数は許容（保存されない表示専用の導出）。 */
export function monthlyReturnRate(annualReturnBp: number): number {
  return Math.pow(1 + annualReturnBp / 10_000, 1 / 12) - 1;
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
    delta += line.side === 'debit' ? line.amount : -line.amount;
  }
  return delta;
}

/**
 * 全対象科目の投影行を生成する。
 *
 * `derivedEntries` には基準日（asOf）まで展開した導出込み仕訳（`reportEntriesForAsOf` の結果）
 * を渡す。today 以前の断面には 1 行も生まれない（起点以前へ不適用・過去は today に不変）。
 */
export function investmentProjectionEntries(
  accounts: readonly Account[],
  derivedEntries: readonly JournalEntry[],
  asOf: string,
  today: string,
): JournalEntry[] {
  const byId = new Map(accounts.map((account) => [account.id, account] as const));
  const cap = asOf < CONTINUOUS_COST_HARD_CAP ? asOf : CONTINUOUS_COST_HARD_CAP;
  if (cap <= today) return []; // 未来の断面を要求されていない = 投影なし
  const out: JournalEntry[] = [];

  for (const account of accounts) {
    // 対象: investment-asset・annualReturnBp ≠ 0・計上先設定済み（未設定/0 = 投影なし）。
    if (account.role !== 'investment-asset') continue;
    const bp = account.annualReturnBp;
    if (bp === undefined || bp === 0 || !Number.isInteger(bp)) continue;
    if (bp < ANNUAL_RETURN_BP_MIN || bp > ANNUAL_RETURN_BP_MAX) continue;
    // fail-closed: 計上先が消えている・income-category でない・自分自身なら生成しない。
    const projectionAccountId = account.projectionAccountId;
    if (projectionAccountId === undefined || projectionAccountId === account.id) continue;
    const projectionAccount = byId.get(projectionAccountId);
    if (!projectionAccount || projectionAccount.role !== 'income-category') continue;
    const rate = monthlyReturnRate(bp);
    if (!Number.isFinite(rate) || rate === 0) continue;

    // 起点残高 = today 時点の導出込み残高。未来分は日付順に織り込む。
    const future = derivedEntries
      .filter((entry) => entry.date > today && entry.lines.some((l) => l.accountId === account.id))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let balance = 0;
    for (const entry of derivedEntries) {
      if (entry.date <= today) balance += balanceDelta(entry, account.id);
    }

    let cursor = 0;
    // 翌月初から月次で適用する。
    for (let month = addMonths(monthOf(today), 1); ; month = addMonths(month, 1)) {
      const date = `${month}-01`;
      if (date > cap) break;
      if (account.endDate !== undefined && date > account.endDate) break; // 線分終了後は生成しない
      // その月初より前の仕訳（未来の積立・引出・ルール投影）を残高へ織り込む。
      while (cursor < future.length && future[cursor]!.date < date) {
        balance += balanceDelta(future[cursor]!, account.id);
        cursor += 1;
      }
      // アーカイブ済み（終了点不明の旧形式含む）・存在期間外の断面には行を立てない。
      if (!accountExistsAt(account, date) || !accountExistsAt(projectionAccount, date)) continue;
      if (balance <= 0) continue; // 残高 0 以下には適用しない（生成なし・複利も進めない）
      const gain = Math.round(balance * rate);
      if (gain === 0) continue;
      const next = balance + gain;
      // 桁あふれガード: 超える月からはこの科目の生成を停止する（それ以前の行は維持）。
      if (!Number.isSafeInteger(next) || Math.abs(next) > PROJECTION_BALANCE_LIMIT) break;
      const amount = Math.abs(gain);
      out.push({
        id: projectionEntryId(account.id, month),
        date,
        description: `投影: ${account.name}`,
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
  return out;
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
