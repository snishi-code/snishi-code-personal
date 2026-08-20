import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadControl = vi.hoisted(() => ({
  count: 0,
  triggerAt: -1,
  beforeTriggeredLoad: null as null | (() => Promise<void>),
  afterSnapshotSaved: null as null | (() => Promise<void>),
}));

vi.mock('../src/data/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/repository')>();
  return {
    ...actual,
    loadLedger: async () => {
      loadControl.count += 1;
      if (loadControl.count === loadControl.triggerAt && loadControl.beforeTriggeredLoad !== null) {
        await loadControl.beforeTriggeredLoad();
      }
      return actual.loadLedger();
    },
    saveSnapshot: async (...args: Parameters<typeof actual.saveSnapshot>) => {
      await actual.saveSnapshot(...args);
      const hook = loadControl.afterSnapshotSaved;
      loadControl.afterSnapshotSaved = null;
      if (hook !== null) await hook();
    },
  };
});

import './setup';
import { exportToJsonText, importFromJsonText } from '../src/data/exportImport';
import { loadLedger, updateSettings, upsertEntry } from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';

describe('import の空判定・snapshot と並行書込みの競合（v13.9: 取り込みは空台帳のみ）', () => {
  beforeEach(() => {
    loadControl.triggerAt = -1;
    loadControl.beforeTriggeredLoad = null;
    loadControl.afterSnapshotSaved = null;
  });

  it('snapshot 用読取りの直前に取引が書かれたら、空でなくなったとして中断し保存を残す', async () => {
    const before = await loadLedger();
    const text = exportToJsonText(before);
    const cash = before.accounts.find((a) => a.name === '現金')!;
    const food = before.accounts.find((a) => a.name === '変動費')!;

    // import 内の 1 回目の loadLedger = snapshot 用読取り（空判定と同じ読取り）。
    loadControl.triggerAt = loadControl.count + 1;
    loadControl.beforeTriggeredLoad = async () => {
      await upsertEntry(
        buildSimpleEntry({
          date: '2026-06-01',
          description: '並行の保存',
          debitAccountId: food.id,
          creditAccountId: cash.id,
          amount: 100,
        }),
      );
    };

    const outcome = await importFromJsonText(text);
    expect(outcome).toMatchObject({
      kind: 'storage-error',
      detail: 'error.import.requiresEmpty',
    });
    // 中断したので並行保存が残る（置換されていない）。
    expect((await loadLedger()).journalEntries.some((e) => e.description === '並行の保存')).toBe(
      true,
    );
  });

  it('snapshot 保存直後の別保存を置換せず、import を中断して保存を残す', async () => {
    const before = await loadLedger();
    const text = exportToJsonText(before);

    loadControl.afterSnapshotSaved = () =>
      updateSettings({ ...before.settings, ledgerName: 'スナップショット後の保存' });

    const outcome = await importFromJsonText(text);
    expect(outcome).toMatchObject({
      kind: 'storage-error',
      detail: 'error.common.staleData',
    });
    expect((await loadLedger()).settings.ledgerName).toBe('スナップショット後の保存');
  });
});
