/*
 * i18n 入口。MVP は ja のみ。t() は {var} 補間に対応する（実装は foundation の createI18n）。
 */
import { createI18n } from '@snishi/foundation/i18n/createI18n';
import { ja, type MessageKey } from './ja';

export type { MessageKey };

const i18n = createI18n(ja);

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return i18n.t(key, vars);
}

/** 例外をユーザー表示文言にする（Error はメッセージそのまま・不明値は汎用文言）。 */
export function errorText(e: unknown, fallback: MessageKey = 'toast.error'): string {
  return e instanceof Error && e.message ? e.message : t(fallback);
}
