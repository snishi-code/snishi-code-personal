import { describe, expect, it } from 'vitest';
import {
  isCurrentSchema,
  journalEntrySchema,
  ledgerExportPackageSchema,
} from '../src/domain/schema';
import { APP_ID, SCHEMA_VERSION } from '../src/domain/constants';

const validEntry = {
  id: 'e1',
  date: '2026-06-01',
  description: 'ランチ',
  kind: 'normal',
  lines: [
    { accountId: 'a', side: 'debit', amount: 1000 },
    { accountId: 'b', side: 'credit', amount: 1000 },
  ],
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

describe('journalEntrySchema', () => {
  it('借方=貸方の仕訳を受け入れる', () => {
    expect(journalEntrySchema.safeParse(validEntry).success).toBe(true);
  });
  it('借方≠貸方は拒否する', () => {
    const bad = {
      ...validEntry,
      lines: [
        { accountId: 'a', side: 'debit', amount: 1000 },
        { accountId: 'b', side: 'credit', amount: 999 },
      ],
    };
    const r = journalEntrySchema.safeParse(bad);
    expect(r.success).toBe(false);
  });
  it('金額が 0 や小数は拒否する', () => {
    expect(
      journalEntrySchema.safeParse({
        ...validEntry,
        lines: [
          { accountId: 'a', side: 'debit', amount: 0 },
          { accountId: 'b', side: 'credit', amount: 0 },
        ],
      }).success,
    ).toBe(false);
    expect(
      journalEntrySchema.safeParse({
        ...validEntry,
        lines: [
          { accountId: 'a', side: 'debit', amount: 10.5 },
          { accountId: 'b', side: 'credit', amount: 10.5 },
        ],
      }).success,
    ).toBe(false);
  });
  it('不正な日付形式は拒否する', () => {
    expect(journalEntrySchema.safeParse({ ...validEntry, date: '2026/06/01' }).success).toBe(false);
  });
});

describe('ledgerExportPackageSchema', () => {
  const validPkg = {
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    ledgerId: 'ledger',
    exportedAt: '2026-06-01T00:00:00.000Z',
    deviceId: 'dev1',
    baseRevision: 0,
    currentRevision: 0,
    accounts: [
      { id: 'a', name: '現金', type: 'asset', archived: false, createdAt: 'x', updatedAt: 'x' },
      { id: 'b', name: '食費', type: 'expense', archived: false, createdAt: 'x', updatedAt: 'x' },
    ],
    journalEntries: [validEntry],
    settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
  };

  it('正しいパッケージを受け入れる', () => {
    expect(ledgerExportPackageSchema.safeParse(validPkg).success).toBe(true);
  });
  it('appId が違うと拒否する', () => {
    expect(ledgerExportPackageSchema.safeParse({ ...validPkg, appId: 'other' }).success).toBe(
      false,
    );
  });
  it('存在しない勘定科目を参照する仕訳は拒否する（参照整合性）', () => {
    // account 'b' を取り除くと、validEntry の貸方 'b' が宙吊りになる
    const dangling = {
      ...validPkg,
      accounts: [validPkg.accounts[0]],
    };
    expect(ledgerExportPackageSchema.safeParse(dangling).success).toBe(false);
  });
  it('勘定科目 ID の重複は拒否する', () => {
    const dup = {
      ...validPkg,
      accounts: [...validPkg.accounts, validPkg.accounts[0]],
    };
    expect(ledgerExportPackageSchema.safeParse(dup).success).toBe(false);
  });
});

describe('isCurrentSchema', () => {
  it('現行版のみ true', () => {
    expect(isCurrentSchema(SCHEMA_VERSION)).toBe(true);
    expect(isCurrentSchema(SCHEMA_VERSION + 1)).toBe(false);
  });
});

describe('entry metadata / allocationPlan', () => {
  it('metadata なしの仕訳も有効', () => {
    expect(journalEntrySchema.safeParse(validEntry).success).toBe(true);
  });
  it('inputMode と allocationPlan を含む仕訳を受け入れる（将来按分の拡張点）', () => {
    const withMeta = {
      ...validEntry,
      metadata: {
        inputMode: 'expense',
        allocationPlan: {
          kind: 'period',
          startDate: '2026-06-01',
          endDate: '2026-12-31',
          method: 'even-monthly',
          recognitionAccountId: 'a',
          deferredAccountId: 'b',
          generatedEntryIds: [],
        },
      },
    };
    expect(journalEntrySchema.safeParse(withMeta).success).toBe(true);
  });
  it('export パッケージで metadata が保持される（round-trip）', () => {
    const pkg = {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      baseRevision: 0,
      currentRevision: 0,
      accounts: [
        { id: 'a', name: '現金', type: 'asset', archived: false, createdAt: 'x', updatedAt: 'x' },
        { id: 'b', name: '食費', type: 'expense', archived: false, createdAt: 'x', updatedAt: 'x' },
      ],
      journalEntries: [
        { ...validEntry, metadata: { inputMode: 'reversal', reversalOfEntryId: 'z' } },
      ],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    };
    const parsed = ledgerExportPackageSchema.safeParse(pkg);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.journalEntries[0]?.metadata?.inputMode).toBe('reversal');
    }
  });
});

describe('journalEntrySchema 行数ルール（MVP: 1 借方・1 貸方）', () => {
  it('3 行以上の複合仕訳は拒否する', () => {
    const threeLines = {
      ...validEntry,
      lines: [
        { accountId: 'a', side: 'debit', amount: 600 },
        { accountId: 'b', side: 'credit', amount: 1000 },
        { accountId: 'c', side: 'debit', amount: 400 },
      ],
    };
    expect(journalEntrySchema.safeParse(threeLines).success).toBe(false);
  });
  it('片側に偏った 2 行（借方2/貸方0）は拒否する', () => {
    const bothDebit = {
      ...validEntry,
      lines: [
        { accountId: 'a', side: 'debit', amount: 500 },
        { accountId: 'b', side: 'debit', amount: 500 },
      ],
    };
    expect(journalEntrySchema.safeParse(bothDebit).success).toBe(false);
  });
});

describe('allocationPlan の参照整合性（package 検証）', () => {
  function pkgWithPlan(plan: Record<string, unknown>) {
    return {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      baseRevision: 0,
      currentRevision: 0,
      accounts: [
        { id: 'a', name: '現金', type: 'asset', archived: false, createdAt: 'x', updatedAt: 'x' },
        { id: 'b', name: '食費', type: 'expense', archived: false, createdAt: 'x', updatedAt: 'x' },
      ],
      journalEntries: [{ ...validEntry, metadata: { allocationPlan: plan } }],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    };
  }
  const base = {
    kind: 'period',
    startDate: '2026-06-01',
    endDate: '2026-12-31',
    method: 'even-monthly',
    recognitionAccountId: 'b',
    deferredAccountId: 'a',
    generatedEntryIds: [] as string[],
  };

  it('科目参照が揃っていれば有効', () => {
    expect(ledgerExportPackageSchema.safeParse(pkgWithPlan(base)).success).toBe(true);
  });
  it('存在しない recognition/deferred 科目は拒否する', () => {
    expect(
      ledgerExportPackageSchema.safeParse(pkgWithPlan({ ...base, recognitionAccountId: 'zzz' }))
        .success,
    ).toBe(false);
  });
  it('存在しない generatedEntryIds は拒否する', () => {
    expect(
      ledgerExportPackageSchema.safeParse(pkgWithPlan({ ...base, generatedEntryIds: ['nope'] }))
        .success,
    ).toBe(false);
  });
  it('既存仕訳 ID を指す generatedEntryIds は許可する', () => {
    expect(
      ledgerExportPackageSchema.safeParse(pkgWithPlan({ ...base, generatedEntryIds: ['e1'] }))
        .success,
    ).toBe(true);
  });
});
