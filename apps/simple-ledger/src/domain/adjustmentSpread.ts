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
 *
 * v13.4 ②: **最後の pin は投資の利回り導出の起点でもある**（`lastAdjustmentAnchors`）。
 * pin より手前の区間は按分が支配し、月次複利はその後ろだけに効く。だから利回りをいつ
 * 変えても pin 区間の過去は 1 円も動かない。
 */
import { isDebitNormal, naturalDelta } from './accounting';
import { isAdjustableAccountType } from './adjustment';
import { addMonthsToDate, monthOf, monthsBetween } from './allocation';
import { investmentReturnDeclaration } from './investmentProjection';
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
 * 投資科目（想定利回りと計上先を宣言済み）だけは利回り導出と同じ計上先へ寄せる。
 * 宣言が無効（計上先が消えた・収入カテゴリでない・自分自身）なら既定へ fail-soft。
 * 宣言の有効性判定は investmentProjection.ts が単一正本（ここで再実装しない）。
 */
function counterpartFor(
  target: Account,
  byId: ReadonlyMap<string, Account>,
  fallback: string,
): string {
  return investmentReturnDeclaration(target, byId)?.projectionAccountId ?? fallback;
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

/** 宣言が確定させた 1 点。「この日、この科目の実残高は actualBalance だった」。 */
export interface AdjustmentAnchor {
  date: string;
  /** 自然符号の実残高（借方正規なら借方が正）。 */
  actualBalance: number;
}

interface CollectedPins {
  /** 科目 ID → その科目の pin（走査順 = comparePins）。 */
  pinsByAccount: Map<string, JournalEntry[]>;
  /**
   * 按分できなかった pin（**完全整合性を欠く**破損データ）。
   * **stored のまま集計へ戻す**: 除外だけして置き換えないと差額が黙って消える。
   * 戻した行は gap 算定の母集合にも入る（adjustmentSpread 側）= 足し戻しと算定が一致する。
   */
  unspread: JournalEntry[];
}

/**
 * **pin の読み方の単一正本**（対象科目 = metadata.adjustment.accountId・順序 = comparePins）。
 * 按分（adjustmentSpread）と投資の複利起点（lastAdjustmentAnchors）が同じ解釈を共有する。
 * 仕訳の行から対象科目を推測しない——metadata が正本。
 *
 * 按分できる pin の条件は**完全整合性**（v13.8 監査 H）:
 *  1. 対象科目が引けて、補正できる type であること
 *  2. 実効計上先（投資は投影計上先・それ以外は記録された相手科目）が引けて、
 *     対象科目と別であること——欠けたまま按分すると、存在しない科目へのスライスや
 *     自己相殺スキップで pin の残高保証が黙って壊れる
 * どれか欠ける pin は unspread（stored のまま集計へ戻す = 復旧表示）。
 */
function collectPins(
  accounts: readonly Account[],
  adjustments: readonly JournalEntry[],
): CollectedPins {
  const byId = new Map(accounts.map((account) => [account.id, account] as const));
  const pinsByAccount = new Map<string, JournalEntry[]>();
  const unspread: JournalEntry[] = [];
  for (const pin of adjustments) {
    const accountId = pin.metadata?.adjustment?.accountId;
    const target = accountId === undefined ? undefined : byId.get(accountId);
    if (accountId === undefined || !target || !isAdjustableAccountType(target.type)) {
      unspread.push(pin);
      continue;
    }
    // 実効計上先 = counterpartFor と同じ解決（投資の宣言が有効なら投影計上先へ寄る。
    // 宣言の無い科目は記録された相手科目そのもの）。存在しない・対象と同一なら按分不能。
    const declared = investmentReturnDeclaration(target, byId)?.projectionAccountId;
    const storedCounterpartId = pin.metadata?.adjustment?.counterpartAccountId;
    const effectiveCounterpartId =
      declared ??
      (storedCounterpartId !== undefined && byId.has(storedCounterpartId)
        ? storedCounterpartId
        : undefined);
    if (effectiveCounterpartId === undefined || effectiveCounterpartId === accountId) {
      unspread.push(pin);
      continue;
    }
    const list = pinsByAccount.get(accountId);
    if (list) list.push(pin);
    else pinsByAccount.set(accountId, [pin]);
  }
  for (const pins of pinsByAccount.values()) pins.sort(comparePins);
  return { pinsByAccount, unspread };
}

/**
 * 科目ごとの**最後の宣言**。その日の残高は按分によって actualBalance に確定する。
 *
 * 投資の利回り導出はここを複利の起点にする（`investmentProjectionResult`）。
 * 最後の pin より手前は按分が支配する区間なので、利回りは 1 円も関与しない。
 */
export function lastAdjustmentAnchors(
  accounts: readonly Account[],
  adjustments: readonly JournalEntry[],
): Map<string, AdjustmentAnchor> {
  const anchors = new Map<string, AdjustmentAnchor>();
  if (adjustments.length === 0) return anchors;
  for (const [accountId, pins] of collectPins(accounts, adjustments).pinsByAccount) {
    const last = pins.at(-1)!;
    anchors.set(accountId, {
      date: last.date,
      actualBalance: last.metadata!.adjustment!.actualBalance,
    });
  }
  return anchors;
}

/** 科目に触れる集計対象仕訳（実効開始 anchor_0 と区間内フローの走査に使う）。 */
function touchingEntries(baseEntries: readonly JournalEntry[], accountId: string): JournalEntry[] {
  return baseEntries
    .filter((entry) => entry.lines.some((line) => line.accountId === accountId))
    .sort(byDate);
}

/** 走査が 1 つの pin について確定させた値。 */
interface PinWalkStep {
  pin: JournalEntry;
  /** 区間の始点（直前の pin。無ければ科目の実効開始・それも無ければ pin 当日）。 */
  anchor: string;
  /**
   * **この pin が存在する世界での pin 直前残高**（= 非補正フロー + それ以前の pin の
   * スライス合計）。投資の複利はこの値に入らない——pin を置いた瞬間、その区間の複利は
   * 按分に置き換わるため（利回り導出の起点は最後の pin）。
   */
  expected: number;
  /** 差額 G = actualBalance − expected。0 なら 1 行も作らない。 */
  gap: number;
}

/**
 * 1 科目の pin 走査（**按分の値の単一正本**）。
 * 按分スライスの生成と「予定 pin の理論残高」（`adjustmentPinExpectedBalance`）が
 * この 1 本を共有する（二重実装を作らない）。
 *
 * 状態（flowBalance / spreadSoFar / previousPinDate）は generator の中だけで進む。
 * 消費側が行を作らない判断（G=0・対象と計上先が同じ破損データ）をしても、走査の
 * 状態は変わらない = 「差額は宣言どおり埋まった」という前提を崩さない。
 */
function* walkPins(
  account: Account,
  pins: readonly JournalEntry[],
  touching: readonly JournalEntry[],
): Generator<PinWalkStep> {
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

    const expected = assertSafeAmount(flowBalance + spreadSoFar);
    const actual = pin.metadata!.adjustment!.actualBalance;
    const gap = assertSafeAmount(actual - expected);
    spreadSoFar = assertSafeAmount(spreadSoFar + gap);
    yield { pin, anchor, expected, gap };
  }
}

/** 予定している pin（作成・編集中で、まだ保存されていない宣言）。 */
export interface AdjustmentPinProbe {
  accountId: string;
  date: string;
  /**
   * 既存 pin の編集ならその ID と作成時刻。同日に複数の pin があるときの走査順
   * （日付 → 作成時刻 → ID）を保存後の世界と一致させるために渡す。
   * 未指定 = 新規宣言なので、同日の既存 pin より**後**に並ぶ（後から宣言した方がその日の
   * 実額を決める・comparePins の規約と同じ）。
   */
  id?: string;
  createdAt?: string;
}

/** 新規宣言の走査順（同日なら既存のどの pin よりも後）。 */
const PROBE_SORT_KEY = '9999-12-31T23:59:59.999Z';

/**
 * **予定 pin の理論残高**（= その pin を置いたあとの世界での pin 直前残高）。
 *
 * 補正シートの「理論残高 / 差分」と repository の保存時 expectedBalance が**同じ値**を
 * 見るための単一正本。`adjustmentSpread` の走査そのものを通すので、シートが見せた差分は
 * 必ず按分されるスライスの合計（G）と一致する。
 *
 * 投資科目で従来値（`accountBalance` に利回り導出を含めた残高）とずれるのが本題:
 * pin を置くとその区間の月次複利は按分に置き換わるので、複利込みの残高は「pin を置いた
 * あとの世界」には存在しない。非投資科目（複利が 1 円も無い科目）では従来値と一致する。
 *
 * `baseEntries` は**補正を除いた**集計対象行（利回り導出も含めない）。
 * `adjustments` に予定 pin 自身を含めない（編集時は呼び出し側が除いて渡す）。
 * 対象科目が引けない / 補正できない type なら 0（保存境界が別途 fail-closed に弾く）。
 */
export function adjustmentPinExpectedBalance(
  accounts: readonly Account[],
  baseEntries: readonly JournalEntry[],
  adjustments: readonly JournalEntry[],
  probe: AdjustmentPinProbe,
): number {
  const account = accounts.find((a) => a.id === probe.accountId);
  if (!account || !isAdjustableAccountType(account.type)) return 0;
  const probePin: JournalEntry = {
    id: probe.id ?? PROBE_SORT_KEY,
    date: probe.date,
    description: '',
    kind: 'normal',
    lines: [],
    // actualBalance は走査の状態に効かない（この pin で打ち切るため）。
    metadata: {
      adjustment: {
        accountId: probe.accountId,
        expectedBalance: 0,
        actualBalance: 0,
        delta: 0,
        counterpartAccountId: probe.accountId,
      },
    },
    createdAt: probe.createdAt ?? PROBE_SORT_KEY,
    updatedAt: probe.createdAt ?? PROBE_SORT_KEY,
  };
  const collected = collectPins(accounts, adjustments);
  const pins = [...(collected.pinsByAccount.get(probe.accountId) ?? []), probePin].sort(
    comparePins,
  );
  // 按分されない pin（unspread）は stored のまま集計に残る = 理論残高の母集合にも含める
  // （adjustmentSpread の gap 算定と同じ世界を見る。監査 H）。
  const effectiveBase =
    collected.unspread.length === 0 ? baseEntries : [...baseEntries, ...collected.unspread];
  for (const step of walkPins(account, pins, touchingEntries(effectiveBase, probe.accountId))) {
    if (step.pin === probePin) return step.expected;
  }
  return 0;
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
  const { pinsByAccount, unspread } = collectPins(accounts, adjustments);
  // unspread の stored 行は最終的に集計へ足し戻される（reportEntries の合流）。gap の算定
  // 母集合からだけ除くと、破損 pin の行が正常 pin の対象科目を動かしたとき、pin 日の残高が
  // actualBalance + その増減 になって残高保証が破れる（監査 H）。算定も同じ世界で行う。
  const effectiveBase = unspread.length === 0 ? baseEntries : [...baseEntries, ...unspread];

  const entries: JournalEntry[] = [];
  for (const [accountId, pins] of pinsByAccount) {
    const account = byId.get(accountId)!;
    for (const { pin, anchor, gap } of walkPins(
      account,
      pins,
      touchingEntries(effectiveBase, accountId),
    )) {
      if (gap === 0) continue;

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
