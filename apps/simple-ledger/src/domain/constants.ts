/**
 * アプリ ID / スキーマ版の正本は data/constants.ts（識別子の監査用一箇所集約・仕様§14）。
 * ドメイン層からの参照（schema.ts ほか）はこの re-export を通す。
 * v2 は v1 の最終モデル（v16 相当）を SCHEMA_VERSION=1 として開始し、レガシー migration は
 * 持たない（仕様§16）。v1 の識別子（snishi-code.simple-ledger）はどこにも使わない（仕様§7）。
 */
export { APP_ID, MAX_LEDGER_REVISION, SCHEMA_VERSION } from '../data/constants';

/**
 * 継続コストの残存価値を寄せる単一の集約台帳口座（role=continuing-cost-asset・内部集約）。
 * 品目ごとに資産科目を作らず、全継続コストの funding/monthly-allocation をこの 1 口座に通す。
 * find-or-create で 1 つだけ存在させる（ADJUSTMENT_ACCOUNTS と同じシングルトン方針）。
 * 勘定科目管理 UI には出さず、BS / 資産内訳には 1 行で表示する。
 */
export const CONTINUOUS_COST_LEDGER_ACCOUNT_ID = 'continuing-cost-ledger' as const;
export const CONTINUOUS_COST_LEDGER_ACCOUNT_NAME = '継続コスト台帳' as const;
