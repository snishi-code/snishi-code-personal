/**
 * アプリ ID / スキーマ版の正本は data/constants.ts（識別子の監査用一箇所集約・仕様§14）。
 * ドメイン層からの参照（schema.ts ほか）はこの re-export を通す。
 * v2 は v1 の最終モデル（v16 相当）を SCHEMA_VERSION=1 として開始し、レガシー migration は
 * 持たない（仕様§16）。v1 の識別子（snishi-code.simple-ledger）はどこにも使わない（仕様§7）。
 */
export { APP_ID, SCHEMA_VERSION } from '../data/constants';

/** 既定の管理区分（『個人用』）。seed と migration で同じ id を使い、既存データを寄せる。 */
export const DEFAULT_MANAGEMENT_SCOPE_ID = 'scope-personal' as const;
export const DEFAULT_MANAGEMENT_SCOPE_NAME = '個人用' as const;

/**
 * 継続コストの未消化残高を寄せる単一の集約台帳口座（role=continuing-cost-asset・内部集約）。
 * 品目ごとに資産科目を作らず、全継続コストの funding/recognition をこの 1 口座に通す。
 * find-or-create で 1 つだけ存在させる（ADJUSTMENT_ACCOUNTS と同じシングルトン方針）。
 * 勘定科目管理 UI には出さず、BS / 資産内訳には 1 行で表示する。
 */
export const CONTINUOUS_COST_LEDGER_ACCOUNT_ID = 'continuing-cost-ledger' as const;
export const CONTINUOUS_COST_LEDGER_ACCOUNT_NAME = '継続コスト台帳' as const;

/**
 * 取り置き資金（目的別）の残高を寄せる単一の集約口座（role=reserve-asset・内部・聖域化）。
 * 目的ごとに勘定科目を作らず、全取り置きをこの 1 口座に通し、目的別残高は仕訳の `metadata.reserveId`
 * 集計で導出する。勘定科目管理 UI には出さず、資産内訳では資金グループの下部に入れ子表示する。
 */
export const RESERVE_LEDGER_ACCOUNT_ID = 'reserve-ledger' as const;
export const RESERVE_LEDGER_ACCOUNT_NAME = '取り置き資金' as const;
