/*
 * ユーザー表示するドメイン/リポジトリ由来のエラー。
 *
 * 方針: domain/repository は UI 文言を直接持たず、「コード + params」だけを投げる。
 * 表示は UI 層（store / 画面）が i18n の errorText() で行う（ja.ts に集約）。
 * これにより保存境界の fail-closed なエラーも i18n を一元化できる。
 *
 * code は MessageKey に限定し、対応する文言が ja.ts に存在することを型で保証する。
 * message には code を入れておき、i18n 表示ができない経路でも素の Error として情報が残る。
 */
import type { MessageKey } from '../i18n';

export type LedgerErrorParams = Record<string, string | number>;

export class LedgerError extends Error {
  readonly code: MessageKey;
  readonly params: LedgerErrorParams | undefined;
  constructor(code: MessageKey, params?: LedgerErrorParams) {
    super(code);
    this.name = 'LedgerError';
    this.code = code;
    this.params = params;
  }
}
