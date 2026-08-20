/*
 * 推移チャートの読み上げ・目盛りの整形。
 *
 * 以前は自前の fmtSigned（`${v < 0 ? '−' : ''}${formatAmount(Math.abs(v), digits)}`）で
 * 符号を付けていたため、(1) 絶対値を先に取ることで「表示桁で 0 に丸まる負値の符号を消す」
 * 処理を素通りして '−0' と読み上げ、(2) 負号が U+2212 で同じ図の最新値（Money = ASCII '-'）と
 * 食い違い、(3) 読み上げに単位が付かない、の 3 つが同時に起きていた。
 * 整形の正本は format.ts 一つ、を固定する。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TrendChart } from '../src/ui/components/TrendChart';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { LedgerProvider } from '../src/state/store';
import { loadLedger, updateSettings } from '../src/data/repository';
import './setup';

afterEach(cleanup);

async function setDigits(digits: 0 | 1 | 2) {
  const ledger = await loadLedger();
  await updateSettings({ ...ledger.settings, displayFractionDigits: digits });
}

function renderChart(values: number[]) {
  return render(
    <ToastProvider>
      <LedgerProvider>
        <TrendChart
          title="推移"
          currency="円"
          data={values.map((value, i) => ({ key: `k${i}`, label: `${i + 1}月`, value }))}
          onSelect={() => undefined}
        />
      </LedgerProvider>
    </ToastProvider>,
  );
}

describe('推移チャートの整形', () => {
  it("表示桁 0 で 0 に丸まる負値を '−0' と読み上げない", async () => {
    await setDigits(0);
    const { container } = renderChart([-49, 100]);
    const text = container.textContent ?? '';
    const arias = [...container.querySelectorAll('[aria-label]')].map((e) =>
      e.getAttribute('aria-label'),
    );
    expect(text).not.toContain('−0');
    expect(text).not.toContain('-0');
    expect(arias.some((a) => a?.includes('-0') || a?.includes('−0'))).toBe(false);
  });

  it('読み上げには単位が付き、負号は Money と同じ ASCII の - を使う', async () => {
    await setDigits(0);
    const { container } = renderChart([-20000, 10000]);
    const texts = [
      ...[...container.querySelectorAll('[aria-label]')].map(
        (e) => e.getAttribute('aria-label') ?? '',
      ),
      container.querySelector('.sr-only')?.textContent ?? '',
    ];
    const negative = texts.find((a) => a.includes('200'));
    expect(negative).toBeDefined();
    expect(negative).toContain('円');
    expect(negative).toContain('-200');
    expect(negative).not.toContain('−'); // U+2212 は使わない
  });
});

describe('期間選択ボタンのタップ領域（v13.9 項目 7・監査 9.2）', () => {
  it('.trend-x__btn の min-height は 44px トークン（var(--tap)）を使う', () => {
    const css = readFileSync(join(process.cwd(), 'src/ui/app.css'), 'utf8');
    const rule = css.slice(css.indexOf('.trend-x__btn {'), css.indexOf('.trend-x__btn:hover'));
    expect(rule).toContain('min-height: var(--tap)');
  });
});
