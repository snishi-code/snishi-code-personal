import { describe, expect, it } from 'vitest';
import { defaultAccounts, defaultSettings } from '../src/data/seed';
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

describe('テスト用 JSON（sample.json）', () => {
  it('正式なエクスポートパッケージとして検証を通る（import 可能な形）', () => {
    const result = ledgerExportPackageSchema.safeParse(sample);
    expect(result.success).toBe(true);
  });
});
