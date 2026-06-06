/*
 * 予定キャッシュフロー（将来の現金の出入り）の投影と実績化。
 *
 * 「いつ費用認識するか(allocation)」とは独立に、「いつ現金が動くか」を扱う。
 *  - planned な CashflowSchedule を期日順に適用し、将来残高・最低残高を投影する。
 *  - 目的別資金(reserve)の残高は「自由資金」から除外する（総資金は変えない）。
 *  - 実績化は 1 件の 2 行仕訳を作る（複合仕訳にしない）。保存は repository（単一 transaction）。
 */
import { newId } from './ids';
import { nowIso } from '../util/time';
import { addMonths, monthOf } from './allocation';
import type { AccountBalance, CashflowSchedule, JournalEntry } from './types';

/**
 * 資金繰りの「総資金」= 流動資産のみ。按分中資産・固定資産・投資など、現金化を伴わない
 * asset は除外する（excludedAccountIds で指定）。目的別資金は流動なので含める（自由資金で控除）。
 */
export function liquidAssetTotal(
  assets: AccountBalance[],
  excludedAccountIds: Set<string>,
): number {
  return assets
    .filter((a) => !excludedAccountIds.has(a.account.id))
    .reduce((s, a) => s + a.balance, 0);
}

/** 予定 CF を実績化する仕訳。outflow: 借方 counter / 貸方 account、inflow: その逆。 */
export function buildScheduleEntry(schedule: CashflowSchedule): JournalEntry {
  if (!schedule.counterAccountId) {
    throw new Error('相手科目が未設定の予定は実績化できません。');
  }
  const ts = nowIso();
  const asset = schedule.accountId;
  const counter = schedule.counterAccountId;
  // outflow（現金が出ていく）: 借方 counter / 貸方 asset
  // inflow（現金が入る）:       借方 asset   / 貸方 counter
  const debit = schedule.direction === 'outflow' ? counter : asset;
  const credit = schedule.direction === 'outflow' ? asset : counter;
  return {
    id: newId(),
    date: schedule.dueDate,
    description: schedule.title,
    kind: 'normal',
    lines: [
      { accountId: debit, side: 'debit', amount: schedule.amount },
      { accountId: credit, side: 'credit', amount: schedule.amount },
    ],
    metadata: { inputMode: 'manual' },
    createdAt: ts,
    updatedAt: ts,
  };
}

export interface CashflowPoint {
  date: string;
  /** その時点の総資金（asset 合計）。 */
  total: number;
  /** 自由資金 = 総資金 − 目的別資金残高。 */
  free: number;
}

export interface CashflowProjection {
  startTotal: number;
  startFree: number;
  reserveBalance: number;
  points: CashflowPoint[];
  minTotal: number;
  minFree: number;
  schedules: CashflowSchedule[];
}

/** 月数ぶん先の期間上限（'YYYY-MM-31' の文字列比較で十分）。 */
export function horizonEnd(today: string, months: number): string {
  return `${addMonths(monthOf(today), months)}-31`;
}

/**
 * planned な予定を期日順に適用して将来残高を投影する。
 * reserveBalance（目的別資金の現在残高）は自由資金から差し引く（投影中は一定とみなす）。
 */
export function projectCashflow(params: {
  totalAssets: number;
  reserveBalance: number;
  schedules: CashflowSchedule[];
  today: string;
  months: number;
}): CashflowProjection {
  const { totalAssets, reserveBalance, schedules, today, months } = params;
  const end = horizonEnd(today, months);
  const planned = schedules
    .filter((s) => s.status === 'planned' && s.dueDate >= today && s.dueDate <= end)
    .slice()
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

  const startTotal = totalAssets;
  const startFree = totalAssets - reserveBalance;
  const points: CashflowPoint[] = [{ date: today, total: startTotal, free: startFree }];

  let total = startTotal;
  for (const s of planned) {
    total += s.direction === 'inflow' ? s.amount : -s.amount;
    points.push({ date: s.dueDate, total, free: total - reserveBalance });
  }

  const minTotal = points.reduce((m, p) => Math.min(m, p.total), startTotal);
  const minFree = points.reduce((m, p) => Math.min(m, p.free), startFree);

  return { startTotal, startFree, reserveBalance, points, minTotal, minFree, schedules: planned };
}
