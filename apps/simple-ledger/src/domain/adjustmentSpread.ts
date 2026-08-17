/*
 * 残高補正の按分（v13.4 ①・作者決定 2026-08-17）。
 *
 * 補正（metadata.adjustment 付きの stored 仕訳）は**集計から外し、「宣言（pin）」として扱う**。
 * pin が言っているのは「この日、この科目の実残高は actualBalance だった」だけで、その差額を
 * どの日に計上するかは pin が決めない。差額は **直前の pin（無ければ科目の実効開始）との区間へ
 * 単純な月割りで按分**したスライス（保存されない導出行）として並べ直す。
 * 狙いは「補正した月だけ収支が跳ねる」のをやめること。
 *
 * 規約:
 *  - **正本は actualBalance だけ**。stored の delta / expectedBalance は作成時の記録であって
 *    集計に使わない（区間が結合・分割されると差額そのものが変わるため）。
 *  - 科目ごとに pin を日付 → 作成時刻 → ID の順へ並べ、区間 I_i = (anchor_{i-1}, p_i] を作る。
 *    anchor_0 = その科目に触れる最初の集計対象仕訳の日付（opening・導出行を含む。1 本も
 *    無ければ p_1 当日）、anchor_{i-1} = p_{i-1} の日付。
 *  - G_i = actualBalance(p_i) − p_i 時点の導出残高（= 非補正フロー + 生成済みスライス）。
 *    走査で逐次計算する（符号は naturalDelta と同じ自然符号）。G_i = 0 なら 1 行も作らない。
 *  - 刻み日と端数は**月割り台帳と同じ規約**（monthlyCost.ts の allocationCuts）。
 *    1 ヶ月未満（同日通過なし）は p_i 当日に全額 1 本。
 *  - 借貸の向きは buildAdjustmentEntry と同じ（counterpartRole の符号規約）。
 *  - 計上先は pin が記録した相手科目（残高調整費 / 収入）。**投資科目だけ**は利回り投影と
 *    同じ計上先（projectionAccountId）へ寄せる（評価損益は調整費ではなく投資の損益）。
 *
 * 不変条件: **各 pin の日以降の残高は、按分前（stored の補正をそのまま集計した世界）と
 * 完全に一致する**。スライスは区間内（p_i 以前）にしか置かれず、合計は必ず G_i になる。
 */
import { isDebitNormal, naturalDelta } from './accounting';
import { isAdjustableAccountType } from './adjustment';
import { addMonthsToDate, monthOf, monthsBetween } from './allocation';
import { ANNUAL_RETURN_BP_MAX, ANNUAL_RETURN_BP_MIN } from './investmentProjection';
import { allocationCuts, type AllocationCut } from './monthlyCost';
import { CATCH_UP_HARD_CAP_MONTHS as MONTHLY_AMOUNTS_HARD_CAP } from './recurringLimits';
import { assertSafeAmount } from './safeSum';
import type { Account, JournalEntry } from './types';

/** 補正（pin）の stored 仕訳か。集計はこれを除外し、按分スライスへ置き換える。 */
export function isAdjustmentEntry(entry: JournalEntry): boolean {
  return entry.metadata?.adjustment !== undefined;
}

/** 按分スライスの決定的 ID（刻みは月内に高々 1 本なので pin ID + 年月で一意）。 */
function sliceEntryId(adjustmentId: string, ym: string): string {
  return `adj-slice-${adjustmentId}-${ym}`;
}

export interface AdjustmentSpreadResult {
  /** 集計へ合流させる按分スライス（保存されない導出行）。 */
  entries: JournalEntry[];
  /**
   * 按分できなかった pin（対象科目が科目一覧に無い等の破損データ）。
   * **stored のまま集計へ戻す**: 除外だけして置き換えないと差額が黙って消える。
   */
  unspread: JournalEntry[];
}

/**
 * 1 つの pin の計上先。既定は pin が記録した相手科目（残高調整費 / 収入）。
 * 投資科目（想定利回りと計上先を宣言済み）だけは利回り投影と同じ計上先へ寄せる。
 * 宣言が無効（計上先が消えた・収入カテゴリでない・自分自身）なら既定へ fail-soft。
 */
function counterpartFor(
  target: Account,
  byId: ReadonlyMap<string, Account>,
  fallback: string,
): string {
  if (target.role !== 'investment-asset') return fallback;
  const bp = target.annualReturnBp;
  if (bp === undefined || bp === 0 || !Number.isInteger(bp)) return fallback;
  if (bp < ANNUAL_RETURN_BP_MIN || bp > ANNUAL_RETURN_BP_MAX) return fallback;
  const projectionAccountId = target.projectionAccountId;
  if (projectionAccountId === undefined || projectionAccountId === target.id) return fallback;
  const projectionAccount = byId.get(projectionAccountId);
  if (!projectionAccount || projectionAccount.role !== 'income-category') return fallback;
  return projectionAccountId;
}

/** その仕訳が対象科目にもたらす自然符号の増減（複数行あっても合算する）。 */
function naturalDeltaOf(entry: JournalEntry, account: Account): number {
  let delta = 0;
  for (const line of entry.lines) {
    if (line.accountId !== account.id) continue;
    delta = assertSafeAmount(delta + naturalDelta(account, line.side, line.amount));
  }
  return delta;
}

/** 日付昇順（走査用。同日どうしの順序は合計に影響しない）。 */
function byDate(a: { date: string }, b: { date: string }): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

/**
 * 宣言の走査順: 日付 → 作成時刻 → ID の昇順。
 * **保存配列の順に依存させない**（loadLedger は日付降順で返すため、配列順に頼ると
 * 同日 2 本のときに古い宣言が後勝ちしてしまう）。同日に 2 本あるなら後から宣言した方が
 * その日の実額を決める = 仕訳一覧の並び（日付降順 → 作成降順）の先頭と一致する。
 */
function comparePins(a: JournalEntry, b: JournalEntry): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 補正（pin）を按分スライスへ展開する。
 *
 * `baseEntries` は**補正を除いた**集計対象の導出込み仕訳（実仕訳 + 継続コスト + ルール導出）。
 * asOf での切り落としは呼び出し側（reportEntriesForAsOf）が最後に行う——按分は asOf に
 * 依存しない（過去の断面が未来の展開で変わらない）ため、ここでは日付で絞らない。
 */
export function adjustmentSpread(
  accounts: readonly Account[],
  baseEntries: readonly JournalEntry[],
  adjustments: readonly JournalEntry[],
): AdjustmentSpreadResult {
  if (adjustments.length === 0) return { entries: [], unspread: [] };
  const byId = new Map(accounts.map((account) => [account.id, account] as const));

  // 科目ごとの pin。metadata が対象科目の正本（仕訳の行から推測しない）。
  const pinsByAccount = new Map<string, JournalEntry[]>();
  const unspread: JournalEntry[] = [];
  for (const pin of adjustments) {
    const accountId = pin.metadata?.adjustment?.accountId;
    const target = accountId === undefined ? undefined : byId.get(accountId);
    // 対象科目が引けない / 補正できない type の破損データは按分せず stored のまま戻す。
    if (accountId === undefined || !target || !isAdjustableAccountType(target.type)) {
      unspread.push(pin);
      continue;
    }
    const list = pinsByAccount.get(accountId);
    if (list) list.push(pin);
    else pinsByAccount.set(accountId, [pin]);
  }

  const entries: JournalEntry[] = [];
  for (const [accountId, pins] of pinsByAccount) {
    const account = byId.get(accountId)!;
    pins.sort(comparePins);
    // 科目に触れる集計対象仕訳（実効開始 anchor_0 と区間内フローの走査に使う）。
    const touching = baseEntries
      .filter((entry) => entry.lines.some((line) => line.accountId === accountId))
      .sort(byDate);
    const effectiveStart = touching[0]?.date;

    let cursor = 0;
    /** 非補正フローだけの自然符号残高（走査位置 = 直近に処理した pin の日まで）。 */
    let flowBalance = 0;
    /** ここまでに生成したスライスの合計（= Σ G_j。すべて直近 pin 以前に置かれている）。 */
    let spreadSoFar = 0;
    let previousPinDate: string | undefined;

    for (const pin of pins) {
      while (cursor < touching.length && touching[cursor]!.date <= pin.date) {
        flowBalance = assertSafeAmount(flowBalance + naturalDeltaOf(touching[cursor]!, account));
        cursor += 1;
      }
      // 区間の始点は「直前の pin」。差額 0 で 1 行も作らなかった pin も宣言点としては生きる。
      const anchor = previousPinDate ?? effectiveStart ?? pin.date;
      previousPinDate = pin.date;

      const actual = pin.metadata!.adjustment!.actualBalance;
      const gap = assertSafeAmount(actual - flowBalance - spreadSoFar);
      if (gap === 0) continue;
      spreadSoFar = assertSafeAmount(spreadSoFar + gap);

      // 向きは buildAdjustmentEntry と同じ規約（借方正規なら gap>0 で対象が借方）。
      const targetOnDebit = isDebitNormal(account.type) ? gap > 0 : gap < 0;
      const counterpartAccountId = counterpartFor(
        account,
        byId,
        pin.metadata!.adjustment!.counterpartAccountId,
      );
      const debitAccountId = targetOnDebit ? accountId : counterpartAccountId;
      const creditAccountId = targetOnDebit ? counterpartAccountId : accountId;
      // 対象と計上先が同じ科目になる破損データでは行を作らない（自己相殺の 2 行は無意味）。
      if (debitAccountId === creditAccountId) continue;

      for (const cut of slicesOf(anchor, pin.date, Math.abs(gap))) {
        if (cut.amount === 0) continue; // 刻み数 > |G| のとき端数配分で 0 の刻みが出る
        entries.push({
          id: sliceEntryId(pin.id, monthOf(cut.date)),
          date: cut.date,
          description: pin.description,
          kind: 'normal',
          lines: [
            { accountId: debitAccountId, side: 'debit', amount: cut.amount },
            { accountId: creditAccountId, side: 'credit', amount: cut.amount },
          ],
          metadata: { virtual: true, adjustmentSliceOf: pin.id },
          createdAt: pin.createdAt,
          updatedAt: pin.updatedAt,
        });
      }
    }
  }
  return { entries, unspread };
}

/**
 * 区間 (anchor, pinDate] の刻み。刻み規約は月割り台帳と同じ（allocationCuts が正本）。
 * 区間が配分上限（100 年）を超える壊れた入力でも投げない——導出は render からも呼ばれるので、
 * anchor を上限ぶん手前まで寄せて直近側へ配る（合計 = total・最終刻み <= pinDate は不変）。
 */
function slicesOf(anchor: string, pinDate: string, total: number): AllocationCut[] {
  // 刻み数の上界（正確な同日通過数は allocationCuts が数え直す）。
  const months = monthsBetween(monthOf(anchor), monthOf(pinDate));
  const start =
    months > MONTHLY_AMOUNTS_HARD_CAP
      ? addMonthsToDate(anchor, months - MONTHLY_AMOUNTS_HARD_CAP)
      : anchor;
  return allocationCuts(start, pinDate, total);
}
