import { describe, expect, it } from 'vitest';
import { createMigrationChain } from './migrations';

interface Final {
  v: number;
  a?: number;
  b?: number;
}

describe('exchange/migrations', () => {
  it('多段 migration が順に適用される', () => {
    const chain = createMigrationChain<Final>([
      { from: 1, to: 2, migrate: (d) => ({ ...(d as object), a: 1 }) },
      { from: 2, to: 3, migrate: (d) => ({ ...(d as object), b: 2 }) },
    ]);
    const res = chain.migrateToVersion({ v: 0 }, 1, 3);
    expect(res).toEqual({ ok: true, data: { v: 0, a: 1, b: 2 } });
  });

  it('同一 version はそのまま通す', () => {
    const chain = createMigrationChain<Final>([]);
    expect(chain.migrateToVersion({ v: 1 }, 3, 3)).toEqual({ ok: true, data: { v: 1 } });
  });

  it('未来版は fail-closed', () => {
    const chain = createMigrationChain<Final>([]);
    const res = chain.migrateToVersion({ v: 1 }, 4, 3);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('too-new');
  });

  it('欠番(step 未登録)は fail-closed', () => {
    const chain = createMigrationChain<Final>([
      { from: 1, to: 2, migrate: (d) => d },
      // 2→3 が無い
    ]);
    const res = chain.migrateToVersion({ v: 1 }, 1, 3);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('missing-step');
  });

  it('migrate が throw したら fail-closed', () => {
    const chain = createMigrationChain<Final>([
      {
        from: 1,
        to: 2,
        migrate: () => {
          throw new Error('broken data');
        },
      },
    ]);
    const res = chain.migrateToVersion({ v: 1 }, 1, 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('migration-failed');
  });

  it('後退/重複 step の登録は構成エラーとして即 throw', () => {
    expect(() => createMigrationChain([{ from: 2, to: 2, migrate: (d) => d }])).toThrow();
    expect(() =>
      createMigrationChain([
        { from: 1, to: 2, migrate: (d) => d },
        { from: 1, to: 3, migrate: (d) => d },
      ]),
    ).toThrow();
  });
});
