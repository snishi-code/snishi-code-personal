/*
 * i18n 入口。MVP は ja のみ。t() は {var} 補間に対応する（実装は foundation の createI18n）。
 * 将来 en を足すときは辞書切替を戻し、MessageKey 集合を共有する。
 */
import { createI18n } from '@snishi/foundation/i18n/createI18n';
import { ja, type MessageKey } from './ja';
import { LedgerError } from '../domain/errors';

export type { MessageKey };

const i18n = createI18n(ja);

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return i18n.t(key, vars);
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
