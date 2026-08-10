/*
 * i18n 入口。MVP は ja のみ。t() は {var} 補間に対応する（実装は foundation の createI18n）。
 * 将来 en を足すときは辞書切替を戻し、MessageKey 集合を共有する。
 */
import { createI18n } from '@snishi/foundation/i18n/createI18n';
import { ja, type MessageKey } from './ja';
import { LedgerError } from '../domain/errors';
import { CsvImportError, type CsvImportErrorCode } from '../domain/importCsv';

export type { MessageKey };

const i18n = createI18n(ja);

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return i18n.t(key, vars);
}

/**
 * CsvImportError の code → `error.csvImport.<code>` キー。テンプレートリテラル型が
 * MessageKey（= ja.ts のキー集合）に代入できることを TS が検査するため、
 * code に対応する文言が ja.ts に欠けるとコンパイルエラーになる。
 */
type CsvImportMessageKey = `error.csvImport.${CsvImportErrorCode}`;

/**
 * 例外をユーザー表示文言にする。
 * LedgerError は code + params を、CsvImportError は `error.csvImport.<code>` を i18n で表示し、
 * それ以外の Error はメッセージをそのまま、不明な値は fallback キーにフォールバックする。
 */
export function errorText(e: unknown, fallback: MessageKey = 'toast.error'): string {
  if (e instanceof LedgerError) return t(e.code, e.params);
  if (e instanceof CsvImportError) {
    const key: CsvImportMessageKey = `error.csvImport.${e.code}`;
    return t(key, e.params);
  }
  return e instanceof Error ? e.message : t(fallback);
}
