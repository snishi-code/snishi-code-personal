/*
 * 初期データ（家計簿向けの既定勘定科目・既定設定）。
 * 内容は初期設定 JSON（`./seed.json`）を正本とし、ここでは id / タイムスタンプなどの
 * 実行時値を付与して組み立てる。旧 GAS の命名は引きずらない（会計科目として再設計）。
 */
import { SCHEMA_VERSION } from '../domain/constants';
import { newId } from '../domain/ids';
import type { AccountRole } from '../domain/accountRoles';
import type { Account, AccountType, LedgerMeta, Settings } from '../domain/types';
import { nowIso } from '../util/time';
import seed from './seed.json';

interface SeedAccount {
  name: string;
  type: AccountType;
  role: AccountRole;
}

// JSON は型が広く推論されるため、本ファイルの型へ寄せる（内容は seed.json が正本）。
const SEED_ACCOUNTS = seed.accounts as SeedAccount[];

export function defaultAccounts(): Account[] {
  const ts = nowIso();
  return SEED_ACCOUNTS.map((a) => ({
    id: newId(),
    name: a.name,
    type: a.type,
    role: a.role,
    archived: false,
    createdAt: ts,
    updatedAt: ts,
  }));
}

export function defaultSettings(): Settings {
  return {
    ledgerName: seed.settings.ledgerName,
    currency: seed.settings.currency,
    locale: 'ja',
  };
}

export function newMeta(): LedgerMeta {
  const ts = nowIso();
  return {
    id: 'ledger',
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    deviceId: newId(),
    createdAt: ts,
    updatedAt: ts,
  };
}
