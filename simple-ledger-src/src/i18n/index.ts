/*
 * i18n 入口。MVP は ja のみ。t() は {var} 補間に対応する。
 * 将来 en を足すときは locale で辞書を切り替え、MessageKey 集合は共有する。
 */
import { ja, type MessageKey } from './ja';
import { LedgerError } from '../domain/errors';

export type { MessageKey };

const dictionaries = { ja } as const;
export type Locale = keyof typeof dictionaries;

let activeLocale: Locale = 'ja';

export function setLocale(locale: Locale): void {
  activeLocale = locale;
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[activeLocale][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_m, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}

/**
 * 例外をユーザー表示文言にする。
 * LedgerError は code + params を i18n で表示し、それ以外の Error はメッセージをそのまま、
 * 不明な値は fallback キー（既定はエラー文言）にフォールバックする。
 */
export function errorText(e: unknown, fallback: MessageKey = 'toast.error'): string {
  if (e instanceof LedgerError) return t(e.code, e.params);
  return e instanceof Error ? e.message : t(fallback);
}
