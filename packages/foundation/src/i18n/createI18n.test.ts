// createI18n: 補間と未知キーの fail-visible を検証する。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from './createI18n';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createI18n', () => {
  it('{name} プレースホルダを補間する (文字列・数値)', () => {
    const { t } = createI18n({
      greet: 'こんにちは {name} さん ({count} 回目)',
      plain: 'そのまま',
    });
    expect(t('greet', { name: '山田', count: 2 })).toBe('こんにちは 山田 さん (2 回目)');
    expect(t('plain')).toBe('そのまま');
  });

  it('未提供のプレースホルダは {key} のまま残す (fail-visible)', () => {
    const { t } = createI18n({ pair: '{a} と {b}' });
    expect(t('pair', { a: 'A' })).toBe('A と {b}');
  });

  it('置換値に含まれる {x} を再展開しない (1 パス置換)', () => {
    const { t } = createI18n({ k: '{a}{b}' });
    expect(t('k', { a: '{b}', b: 'X' })).toBe('{b}X');
  });

  it('未知キーはキー文字列を返し、console.warn は 1 キー 1 回だけ', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { t } = createI18n<Record<string, string>>({ known: 'OK' });
    expect(t('missing.key')).toBe('missing.key');
    expect(t('missing.key')).toBe('missing.key');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(t('missing.other')).toBe('missing.other');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(t('known')).toBe('OK');
  });
});
