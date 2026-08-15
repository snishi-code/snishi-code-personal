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
import { loadLedger, updateSettings } from '../src/data/repository';

describe('import の revision 確認から snapshot までの競合', () => {
  beforeEach(() => {
    loadControl.triggerAt = -1;
    loadControl.beforeTriggeredLoad = null;
    loadControl.afterSnapshotSaved = null;
  });

  it('確認直後の別保存を新しい current として採用せず、import を中断して保存を残す', async () => {
    const before = await loadLedger();
    const text = exportToJsonText(before);

    // import 内の1回目 = step ⑤ revision確認、2回目 = step ⑥ snapshot用読取り。
    loadControl.triggerAt = loadControl.count + 2;
    loadControl.beforeTriggeredLoad = () =>
      updateSettings({ ...before.settings, ledgerName: '確認後の保存' });

    const outcome = await importFromJsonText(text);
    expect(outcome.kind).toBe('storage-error');
    // import が通っていれば封筒側（元の台帳名）へ戻る。中断したので並行保存が残る。
    expect((await loadLedger()).settings.ledgerName).toBe('確認後の保存');
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
