/*
 * localStorage の軽量フラグ（UI 導線の既読状態など。台帳データは置かない）。
 * 台帳の正本は IndexedDB。フラグは失っても安全な値のみ（再表示されるだけ）。
 *
 * localStorage が使えない環境（private mode / テスト環境の無効スタブ等）でも
 * throw せず、セッション内はメモリ・フォールバックで既読状態を保つ（fail-soft:
 * 永続化できない場合は次回起動時に再表示されるだけ）。
 */
import { LOCAL_PREFIX } from './constants';

const ONBOARDING_DONE_KEY = `${LOCAL_PREFIX}onboardingDone`;

// localStorage が黙って書き込みを落とす実装でもセッション内で一貫するよう、常に併記する。
const memory = new Map<string, string>();

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // fail-soft
  }
}

function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // fail-soft
  }
}

/** 初期残高の一括登録シートを「完了 or スキップ済み」にしたか。 */
export function isOnboardingDone(): boolean {
  return memory.get(ONBOARDING_DONE_KEY) === '1' || lsGet(ONBOARDING_DONE_KEY) === '1';
}

export function markOnboardingDone(): void {
  memory.set(ONBOARDING_DONE_KEY, '1');
  lsSet(ONBOARDING_DONE_KEY, '1');
}

/** 全データ削除で初期状態へ戻すとき用（次回起動でオンボーディングを再表示）。 */
export function clearOnboardingDone(): void {
  memory.delete(ONBOARDING_DONE_KEY);
  lsRemove(ONBOARDING_DONE_KEY);
}

const LAST_EXPENSE_CATEGORY_KEY = `${LOCAL_PREFIX}lastExpenseCategoryId`;

/** 継続コスト登録などで前回選んだ費用カテゴリ（次回の既定値。無ければ null）。 */
export function lastExpenseCategoryId(): string | null {
  return memory.get(LAST_EXPENSE_CATEGORY_KEY) ?? lsGet(LAST_EXPENSE_CATEGORY_KEY);
}

export function rememberExpenseCategoryId(id: string): void {
  memory.set(LAST_EXPENSE_CATEGORY_KEY, id);
  lsSet(LAST_EXPENSE_CATEGORY_KEY, id);
}

/*
 * v13.4 ③ で `${LOCAL_PREFIX}cashflowHorizonMonths` は引退した（資金繰りの範囲は
 * 基準日起点の横スクロールで決まり、既定期間という設定自体が無くなった）。
 * 端末に残った旧キーは読まないだけ = 読み捨て（移行処理は要らない。この層の値は
 * 失っても安全で、他のキーには一切ふれない）。
 */
