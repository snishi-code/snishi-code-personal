import { describe, expect, it } from 'vitest';
import './setup';
import {
  defaultAccounts,
  defaultSettings,
  isDefaultSeedAccounts,
  isDefaultSettings,
} from '../src/data/seed';
import { roleAllowsType } from '../src/domain/accountRoles';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import sample from '../src/data/sample.json';

describe('初期設定 JSON（seed.json）', () => {
  it('既定科目は role と type が整合し、一意の id を持つ', () => {
    const accounts = defaultAccounts();
    expect(accounts.length).toBeGreaterThan(0);
    for (const a of accounts) {
      expect(roleAllowsType(a.role, a.type)).toBe(true);
      expect(a.archived).toBe(false);
    }
    const ids = new Set(accounts.map((a) => a.id));
    expect(ids.size).toBe(accounts.length);
  });

  it('既定設定は locale=ja / 通貨 JPY', () => {
    const s = defaultSettings();
    expect(s.locale).toBe('ja');
    expect(s.currency).toBe('JPY');
    expect(s.ledgerName.length).toBeGreaterThan(0);
  });
});

describe('fixture 投入の安全判定（初期 seed そのまま判定）', () => {
  it('既定科目そのままなら isDefaultSeedAccounts は true', () => {
    expect(isDefaultSeedAccounts(defaultAccounts())).toBe(true);
  });

  it('科目名の変更だけでも false（科目を整理した台帳を上書きしない）', () => {
    const accounts = defaultAccounts();
    accounts[0] = { ...accounts[0]!, name: 'メイン口座' };
    expect(isDefaultSeedAccounts(accounts)).toBe(false);
  });

  it('科目の追加だけでも false', () => {
    const accounts = defaultAccounts();
    accounts.push({ ...accounts[0]!, name: '臨時口座' });
    expect(isDefaultSeedAccounts(accounts)).toBe(false);
  });

  it('科目の削除（archived 化）でも false', () => {
    const accounts = defaultAccounts();
    accounts[0] = { ...accounts[0]!, archived: true };
    expect(isDefaultSeedAccounts(accounts)).toBe(false);
  });

  it('既定設定そのままなら isDefaultSettings は true、変更で false', () => {
    expect(isDefaultSettings(defaultSettings())).toBe(true);
    expect(isDefaultSettings({ ...defaultSettings(), ledgerName: 'わが家の家計' })).toBe(false);
    expect(isDefaultSettings({ ...defaultSettings(), currency: 'USD' })).toBe(false);
  });
});

describe('テスト用 JSON（sample.json）', () => {
  it('正式なエクスポートパッケージとして検証を通る（import 可能な形）', () => {
    const result = ledgerExportPackageSchema.safeParse(sample);
    expect(result.success).toBe(true);
  });

  it('手動テストに十分な量のデータを含む（仕訳・月額化・予定CF・目的別資金・タグ）', () => {
    expect(sample.journalEntries.length).toBeGreaterThanOrEqual(15);
    expect(sample.monthlyCostItems.length).toBeGreaterThanOrEqual(1);
    expect(sample.cashflowSchedules.length).toBeGreaterThanOrEqual(1);
    expect(sample.reserves.length).toBeGreaterThanOrEqual(1);
    expect(sample.tags.length).toBeGreaterThanOrEqual(1);
    // 全仕訳は MVP 仕様どおり 1 借方・1 貸方の 2 行。
    for (const e of sample.journalEntries) {
      expect(e.lines.length).toBe(2);
    }
  });

  it('seed の粗いカテゴリ（収入/費用）を一通り使う', () => {
    const seedCategoryNames = defaultAccounts()
      .filter((a) => a.role === 'income-category' || a.role === 'expense-category')
      .map((a) => a.name);
    const idByName = new Map(sample.accounts.map((a) => [a.name, a.id]));
    const usedAccountIds = new Set(
      sample.journalEntries.flatMap((e) => e.lines.map((l) => l.accountId)),
    );
    for (const name of seedCategoryNames) {
      const id = idByName.get(name);
      expect(id, `sample.json に「${name}」科目が無い`).toBeDefined();
      expect(usedAccountIds.has(id!), `「${name}」が仕訳で使われていない`).toBe(true);
    }
  });
});
