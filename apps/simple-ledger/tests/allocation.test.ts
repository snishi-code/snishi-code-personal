/*
 * monthlyAmounts（月割りの単一正本）の直接テスト（指示書v3 §A-4 で新設）。
 * v11 = minor がそのまま入る（コード変更なし）。合計保存則は base + 先頭配りの構造で成立し、
 * `%` 不使用のため負値でも保存される。表示の丸めは表示層の責務（ここでは扱わない）。
 */
import { describe, expect, it } from 'vitest';
import { monthlyAmounts } from '../src/domain/allocation';
import { formatAmount, formatMoney } from '../src/util/format';
import { assertSafeAmount, sumAmounts } from '../src/domain/safeSum';
import { parseAmountToMinor, formatMinorForInput } from '../src/ui/amountText';

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

describe('monthlyAmounts の合計保存則', () => {
  it.each([
    [1, 3],
    [99, 3],
    [100, 3],
    [101, 3],
    [100099, 3],
    [123456, 7],
    [-1, 3],
    [-99, 3],
    [-100, 3],
    [-101, 3],
    [-100099, 3],
    [-123456, 7],
  ])('total=%i months=%i で配分合計 = total', (total, months) => {
    expect(sum(monthlyAmounts(total, months))).toBe(total);
  });

  it('minor での実測期待値（1,000.00 の 3 分割）', () => {
    expect(monthlyAmounts(100000, 3)).toEqual([33334, 33333, 33333]);
  });

  it('割り切れる場合は v10 結果の ×100 と厳密一致する（実データの大半）', () => {
    for (const [x, m] of [
      [240000, 60],
      [1200, 12],
      [500, 5],
    ] as const) {
      expect(monthlyAmounts(x * 100, m)).toEqual(monthlyAmounts(x, m).map((v) => v * 100));
    }
  });

  it('割り切れない場合は v10 ×100 とは一致しない（v11 の意図した仕様変更 = 端数が全月へ細かく再配分）', () => {
    expect(monthlyAmounts(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(monthlyAmounts(100, 3).map((v) => v * 100)).toEqual([3400, 3300, 3300]);
  });
});

describe('safeSum（集計の checked sum・指示書v3 §A-4）', () => {
  it('安全整数域は素通り、超過は LedgerError', () => {
    expect(assertSafeAmount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => assertSafeAmount(Number.MAX_SAFE_INTEGER + 1)).toThrowError();
    expect(sumAmounts([1, 2, 3])).toBe(6);
    expect(() => sumAmounts([Number.MAX_SAFE_INTEGER, 1])).toThrowError();
  });
});

describe('formatAmount / formatMoney のリテラル固定（自己参照にしない = 100 倍バグを実際に捕まえる）', () => {
  it('digits=0（既定）', () => {
    expect(formatMoney(123400, '円', 0)).toBe('1,234 円');
    expect(formatMoney(123450, '円', 0)).toBe('1,235 円'); // 表示のみ四捨五入（half away from zero）
    expect(formatMoney(-50, '円', 0)).toBe('-1 円');
    expect(formatMoney(0, '円', 0)).toBe('0 円');
  });
  it('digits=2', () => {
    expect(formatMoney(123400, 'USD', 2)).toBe('1,234.00 USD');
    expect(formatMoney(123450, '$', 2)).toBe('1,234.50 $');
    expect(formatMoney(-50, '円', 2)).toBe('-0.50 円');
  });
  it('digits=1', () => {
    expect(formatAmount(123450, 1)).toBe('1,234.5');
    expect(formatAmount(123455, 1)).toBe('1,234.6');
  });
  it('単位が空文字なら数値のみ（ledger 未ロード時の防御）', () => {
    expect(formatMoney(123400, '', 0)).toBe('1,234');
  });
});

describe('amountText（テキスト ⇄ minor・表示桁数連動）', () => {
  it('sanitize は設定桁まで受け付ける', () => {
    expect(parseAmountToMinor('1234')).toBe(123400);
    expect(parseAmountToMinor('19.99')).toBe(1999); // float 経由なし
    expect(parseAmountToMinor('12.')).toBe(1200);
    expect(parseAmountToMinor('.5')).toBe(50);
  });
  it('カンマは桁区切り・全角は削除（v2 の矛盾の解消 = 正は削除）', async () => {
    const { sanitizeAmountText } = await import('../src/ui/amountText');
    expect(sanitizeAmountText('1,234', 0)).toBe('1234');
    expect(sanitizeAmountText('12,34', 0)).toBe('1234');
    expect(sanitizeAmountText('１２３', 0)).toBe('');
    expect(sanitizeAmountText('12.345', 2)).toBe('12.34');
    expect(sanitizeAmountText('12.34', 0)).toBe('1234');
  });
  it('編集フォームの初期値は設定桁で丸めた文字列（保存し直すとその値になる・作者決定 2026-08-13）', () => {
    expect(formatMinorForInput(1234, 0)).toBe('12'); // 12.34 を digits=0 で開くと '12'
    expect(formatMinorForInput(1234, 2)).toBe('12.34');
    expect(formatMinorForInput(1230, 2)).toBe('12.3');
    expect(formatMinorForInput(-50, 2)).toBe('-0.5');
    expect(formatMinorForInput(120000, 0)).toBe('1200');
  });
});
