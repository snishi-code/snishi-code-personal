/*
 * firstRecurringPostingDate（定期ルール編集シートの起票プレビュー）の規則:
 *  - recurringPostingsDue と同じ位相（startMonth 基点の i % everyMonths）・clampDayToMonth・
 *    半開区間 [startDate, endDate) で「最初に起票される日付」を返す。
 *  - 期間内に起票日が 1 つも無ければ null。
 */
import { describe, expect, it } from 'vitest';
import { firstRecurringPostingDate, recurringPostingsDue } from '../src/domain/recurring';
import type { RecurringRule } from '../src/domain/types';

function rule(
  partial: Pick<RecurringRule, 'startMonth' | 'dayOfMonth' | 'everyMonths' | 'startDate'> &
    Partial<Pick<RecurringRule, 'endDate'>>,
): RecurringRule {
  return {
    id: 'rule-1',
    name: 'テスト',
    amount: 1000,
    spreadExpenseAccountId: 'debit',
    debitAccountId: 'debit',
    creditAccountId: 'credit',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('firstRecurringPostingDate', () => {
  it('毎月ルール: 開始日以後の最初の基準日を返す', () => {
    expect(
      firstRecurringPostingDate({
        startMonth: '2026-01',
        dayOfMonth: 10,
        everyMonths: 1,
        startDate: '2026-01-01',
      }),
    ).toBe('2026-01-10');
  });

  it('基準日の年月が位相を決める（基準月を 1 ヶ月ずらすと初回もずれる）', () => {
    expect(
      firstRecurringPostingDate({
        startMonth: '2026-02',
        dayOfMonth: 10,
        everyMonths: 3,
        startDate: '2026-01-01',
      }),
    ).toBe('2026-02-10');
  });

  it('開始日が未来なら、開始日以後の最初の位相月を返す', () => {
    expect(
      firstRecurringPostingDate({
        startMonth: '2026-01',
        dayOfMonth: 10,
        everyMonths: 3,
        startDate: '2026-06-01',
      }),
    ).toBe('2026-07-10');
  });

  it('開始日が同月の基準日より後なら翌周期へ送る', () => {
    expect(
      firstRecurringPostingDate({
        startMonth: '2026-01',
        dayOfMonth: 10,
        everyMonths: 1,
        startDate: '2026-01-15',
      }),
    ).toBe('2026-02-10');
  });

  it('31 日は月内へクランプする（2 月 → 28 日）', () => {
    expect(
      firstRecurringPostingDate({
        startMonth: '2026-01',
        dayOfMonth: 31,
        everyMonths: 1,
        startDate: '2026-02-01',
      }),
    ).toBe('2026-02-28');
  });

  it('終了点は排他的: 起票日と同日なら期間外 = null、翌日なら含む', () => {
    const base = {
      startMonth: '2026-01',
      dayOfMonth: 10,
      everyMonths: 1,
      startDate: '2026-01-01',
    };
    expect(firstRecurringPostingDate({ ...base, endDate: '2026-01-10' })).toBeNull();
    expect(firstRecurringPostingDate({ ...base, endDate: '2026-01-11' })).toBe('2026-01-10');
  });

  it('開始日以後の最初の位相月が終了点を越えるなら null（間の月は位相外）', () => {
    expect(
      firstRecurringPostingDate({
        startMonth: '2026-01',
        dayOfMonth: 10,
        everyMonths: 12,
        startDate: '2026-02-01',
        endDate: '2026-06-01',
      }),
    ).toBeNull();
  });

  it('recurringPostingsDue の先頭と一致する（規則の正本が同じ）', () => {
    const r = rule({
      startMonth: '2026-01',
      dayOfMonth: 31,
      everyMonths: 3,
      startDate: '2026-03-15',
    });
    const due = recurringPostingsDue(r, '2027-12-31');
    expect(due[0]?.date).toBe(
      firstRecurringPostingDate({
        startMonth: r.startMonth,
        dayOfMonth: r.dayOfMonth,
        everyMonths: r.everyMonths,
        startDate: r.startDate,
      }),
    );
  });
});
