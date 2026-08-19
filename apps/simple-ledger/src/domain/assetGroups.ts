/*
 * 資産の 4 グループ（自由に動かせるお金 / 自由に動かせないお金 / 投資 / 月割り台帳）。
 *
 * ホームの資産ドリル（`Breakdown` の 4 枠）と、時間平面の数値レンズの資産行の展開
 * （`periodMatrix`）が**同じ分類関数**を使うための単一正本。role と movable の組み合わせを
 * 2 か所で書き分けない。
 *
 * `assetGroupOf` は資産科目に対して**必ず 1 つ**のグループを返す（全域関数）。
 * 想定外の role が来てもどこにも入らない資産を作らない = 「グループの合計 = 総資産」を
 * 壊さないための取り決め（schema 上 asset の role は 3 種だが、既定を明示しておく）。
 *
 * **ここは分類だけを持つ。並び（4 グループをどの順で出すか）は `domain/displayOrder` の
 * 箱の並びが正本**（`ASSET_GROUP_KEYS`）。分類と並びを 2 か所で書き分けないための役割分担。
 */
import type { MessageKey } from '../i18n';
import type { Account } from './types';

export type AssetGroupKey = 'free' | 'fixed' | 'investment' | 'ledger';

export const ASSET_GROUP_LABEL_KEYS: Record<AssetGroupKey, MessageKey> = {
  free: 'assets.frame.free',
  fixed: 'assets.frame.fixed',
  investment: 'assets.frame.investment',
  ledger: 'assets.frame.ledger',
};

/** 資産科目のグループ。資産以外は undefined（グループを持たない）。 */
export function assetGroupOf(account: Account): AssetGroupKey | undefined {
  if (account.type !== 'asset') return undefined;
  switch (account.role) {
    case 'investment-asset':
      return 'investment';
    case 'continuing-cost-asset':
      return 'ledger';
    case 'daily-asset':
    default:
      // movable === false（動かせない印）だけを「自由に動かせないお金」へ寄せる。
      return account.movable === false ? 'fixed' : 'free';
  }
}
