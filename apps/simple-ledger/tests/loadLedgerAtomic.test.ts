import { describe, expect, it, vi } from 'vitest';

const readScopes = vi.hoisted(() => [] as string[][]);

vi.mock('../src/data/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/db')>();
  return {
    ...actual,
    runRead: async <T>(
      stores: (typeof actual.STORE)[keyof typeof actual.STORE][],
      fn: (transaction: IDBTransaction) => Promise<T>,
    ): Promise<T> => {
      readScopes.push([...stores]);
      return actual.runRead(stores, fn);
    },
  };
});

import './setup';
import { STORE } from '../src/data/db';
import { loadLedger } from '../src/data/repository';

describe('loadLedger の原子的読取り', () => {
  it('meta/settings と全本体 store を1つの readonly transaction で読む', async () => {
    await loadLedger();

    const ledgerScope = readScopes.at(-1);
    expect(new Set(ledgerScope)).toEqual(
      new Set([
        STORE.kv,
        STORE.accounts,
        STORE.journalEntries,
        STORE.cashflowSchedules,
        STORE.tags,
        STORE.monthlyCostItems,
        STORE.recurringRules,
      ]),
    );
  });
});
