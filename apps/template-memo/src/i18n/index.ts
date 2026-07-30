/*
 * i18n 入口。MVP は ja のみ。文言カタログは ./rounds の s ただ一つ。
 * コンポーネントは `import { s } from '../i18n'` で引く (コピー元の import 面を維持)。
 */
import { s } from './rounds';

export { s };

/** 例外をユーザー表示文言にする（Error はメッセージそのまま・不明値は汎用文言）。 */
export function errorText(e: unknown, fallback: string = s.toast.error): string {
  return e instanceof Error && e.message ? e.message : fallback;
}
