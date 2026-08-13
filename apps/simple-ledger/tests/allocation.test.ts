/*
 * monthlyAmounts（月割りの単一正本）の直接テスト（指示書v3 §A-4 で新設）。
 * v11 = minor がそのまま入る（コード変更なし）。合計保存則は base + 先頭配りの構造で成立し、
 * `%` 不使用のため負値でも保存される。表示の丸めは表示層の責務（ここでは扱わない）。
 */
import { describe, expect, it } from 'vitest';
import { monthlyAmounts } from '../src/domain/allocation';
import { formatAmount, formatMoney } from '../src/util/format';
import { assertSafeAmount, sumAmounts } from '../src/domain/safeSum';
import { LedgerError } from '../src/domain/errors';
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
  it('カンマは桁区切り・全角は削除、小数点は表示桁で切り捨て（削除ではない）', async () => {
    const { sanitizeAmountText } = await import('../src/ui/amountText');
    expect(sanitizeAmountText('1,234', 0)).toBe('1234');
    expect(sanitizeAmountText('12,34', 0)).toBe('1234');
    expect(sanitizeAmountText('１２３', 0)).toBe('');
    expect(sanitizeAmountText('12.345', 2)).toBe('12.34');
    // digits=0 は小数点**以降**を捨てる。削除して連結すると 100 倍になる。
    expect(sanitizeAmountText('12.34', 0)).toBe('12');
    expect(sanitizeAmountText('1,234.56', 0)).toBe('1234');
  });
  it('編集フォームの初期値は設定桁で丸めた文字列（保存し直すとその値になる・作者決定 2026-08-13）', () => {
    expect(formatMinorForInput(1234, 0)).toBe('12'); // 12.34 を digits=0 で開くと '12'
    expect(formatMinorForInput(1234, 2)).toBe('12.34');
    expect(formatMinorForInput(1230, 2)).toBe('12.3');
    expect(formatMinorForInput(-50, 2)).toBe('-0.5');
    // 表示桁で 0 に丸まる負値に符号を残さない（'-0' は入力し直せない値）。
    expect(formatMinorForInput(-49, 0)).toBe('0');
    expect(formatMinorForInput(-4, 1)).toBe('0');
    expect(formatMinorForInput(-51, 0)).toBe('-1');
    expect(formatMinorForInput(120000, 0)).toBe('1200');
  });
});

describe('丸めた結果が 0 の額は符号を出さない（Codex 指摘・-0 / +0 の抑制）', () => {
  it('表示桁 0 で ±0.49 は "0"（"-0" / "+0" にしない）', async () => {
    const { displayRoundsToZero } = await import('../src/util/format');
    const { moneyText } = await import('../src/ui/money');
    expect(formatMoney(-49, '円', 0)).toBe('0 円');
    expect(formatMoney(49, '円', 0)).toBe('0 円');
    expect(moneyText(49, '円', 0, true)).toBe('0 円'); // signed でも '+' を付けない
    expect(moneyText(-49, '円', 0, true)).toBe('0 円');
    expect(displayRoundsToZero(49, 0)).toBe(true);
    expect(displayRoundsToZero(50, 0)).toBe(false); // 0.50 は 1 へ丸まる
  });

  it('丸めても 0 でないなら従来どおり符号が付く', async () => {
    const { moneyText } = await import('../src/ui/money');
    expect(moneyText(50, '円', 0, true)).toBe('+1 円');
    expect(moneyText(-50, '円', 0, true)).toBe('-1 円');
    expect(moneyText(49, '円', 2, true)).toBe('+0.49 円'); // 表示桁 2 なら 0 ではない
  });
});

describe('monthlyAmounts の極値（合計一致の不変条件を壊さない）', () => {
  it('安全整数域を出る割り算は fail-closed で止める（黙って合計がずれた配分を返さない）', () => {
    // base * months = -(2^53+1) となり、剰余の計算が浮動小数で狂う組み合わせ。
    expect(() => monthlyAmounts(-9007199254740991, 3)).toThrow(LedgerError);
    // 正の極値は floor が下向きに寄るため product が安全域に収まり、正しく配れる。
    expect(sum(monthlyAmounts(Number.MAX_SAFE_INTEGER, 3))).toBe(Number.MAX_SAFE_INTEGER);
    // months が 0 以下でも（Infinity / NaN 経由で）止まる。
    expect(() => monthlyAmounts(1000, 0)).toThrow(LedgerError);
  });

  it('現実域（1 仕訳の上限 10^12 minor）では合計が厳密に一致する', () => {
    for (const total of [-1_000_000_000_000, -101, -1, 0, 1, 101, 1_000_000_000_000]) {
      for (const months of [1, 2, 3, 7, 12, 120]) {
        const parts = monthlyAmounts(total, months);
        expect(parts).toHaveLength(months);
        expect(parts.reduce((s, v) => s + v, 0)).toBe(total);
      }
    }
  });
});
