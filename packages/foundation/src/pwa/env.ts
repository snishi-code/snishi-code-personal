// 移植元: snishi-code ホスト名規約 (head の env 判定スクリプトが data-env を設定する前提)

export type AppEnv = 'prod' | 'test';

/**
 * document.documentElement.dataset.env ('prod' | 'test') を読む。
 * 未設定・不明値は 'test' に倒す (fail-safe: 本番限定の副作用 = SW 登録などを
 * 誤って有効化するより、テスト判定で何もしない方が安全)。
 */
export function getEnv(): AppEnv {
  if (typeof document === 'undefined') return 'test';
  return document.documentElement.dataset.env === 'prod' ? 'prod' : 'test';
}
