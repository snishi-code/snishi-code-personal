/*
 * アプリ状態の単一ソース。IndexedDB(repository) を包み、画面へ ledger と操作を配る。
 * 成功は toast、失敗は error toast + 例外で通知する（保存失敗時に成功 toast を出さない）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  Account,
  AdjustmentKind,
  CashflowSchedule,
  Ledger,
  Settings,
  Snapshot,
  Tag,
} from '../domain/types';
import { buildSimpleEntry, type SimpleEntryInput } from '../domain/entry';
import type { AllocationInput } from '../domain/allocation';
import * as repo from '../data/repository';
import {
  exportFileName,
  exportToJsonText,
  importFromJsonText,
  restoreFromSnapshot,
  type ImportOutcome,
} from '../data/exportImport';
import { useToast } from '../ui/toast';
import { t } from '../i18n';

interface LedgerContextValue {
  status: 'loading' | 'ready' | 'error';
  ledger: Ledger | null;
  error?: string;
  refresh: () => Promise<void>;
  saveEntry: (
    input: SimpleEntryInput,
    existing?: { id: string; createdAt: string },
  ) => Promise<void>;
  removeEntry: (id: string, description: string) => Promise<void>;
  createAllocation: (input: Omit<AllocationInput, 'deferredAccountId'>) => Promise<void>;
  saveSchedules: (schedules: CashflowSchedule[]) => Promise<void>;
  postSchedule: (id: string) => Promise<void>;
  removeSchedule: (id: string) => Promise<void>;
  createReserve: (input: {
    name: string;
    targetAmount?: number;
    note?: string;
    existingAccountId?: string;
  }) => Promise<void>;
  removeReserve: (id: string) => Promise<void>;
  saveTag: (tag: Tag) => Promise<void>;
  removeTag: (id: string) => Promise<void>;
  createAdjustment: (input: {
    kind: AdjustmentKind;
    accountId: string;
    date: string;
    actualBalance: number;
    description?: string;
  }) => Promise<void>;
  saveAccount: (account: Account) => Promise<void>;
  removeAccount: (id: string) => Promise<void>;
  saveSettings: (settings: Settings) => Promise<void>;
  exportJson: () => void;
  importJson: (text: string, force?: boolean) => Promise<ImportOutcome>;
  listSnapshots: () => Promise<Snapshot[]>;
  restoreSnapshot: (snapshot: Snapshot) => Promise<void>;
  deleteSnapshot: (id: string) => Promise<void>;
  resetAll: () => Promise<void>;
}

const LedgerContext = createContext<LedgerContextValue | null>(null);

export function LedgerProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const next = await repo.loadLedger();
    setLedger(next);
    setStatus('ready');
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const next = await repo.loadLedger();
        if (active) {
          setLedger(next);
          setStatus('ready');
        }
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus('error');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const saveEntry = useCallback<LedgerContextValue['saveEntry']>(
    async (input, existing) => {
      try {
        const entry = buildSimpleEntry(input, existing);
        await repo.upsertEntry(entry);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(t('toast.error'), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const removeEntry = useCallback<LedgerContextValue['removeEntry']>(
    async (id) => {
      try {
        await repo.deleteEntry(id);
        await refresh();
        toast.show(t('toast.deleted'), 'success');
      } catch (e) {
        toast.show(e instanceof Error ? e.message : t('toast.error'), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const createAllocation = useCallback<LedgerContextValue['createAllocation']>(
    async (input) => {
      try {
        await repo.createAllocation(input);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(e instanceof Error ? e.message : t('toast.error'), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const saveSchedules = useCallback<LedgerContextValue['saveSchedules']>(
    async (schedules) => {
      try {
        await repo.upsertSchedules(schedules);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(e instanceof Error ? e.message : t('toast.error'), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const postSchedule = useCallback<LedgerContextValue['postSchedule']>(
    async (id) => {
      try {
        await repo.postSchedule(id);
        await refresh();
        toast.show(t('toast.posted'), 'success');
      } catch (e) {
        toast.show(e instanceof Error ? e.message : t('toast.error'), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const removeSchedule = useCallback<LedgerContextValue['removeSchedule']>(
    async (id) => {
      try {
        await repo.deleteSchedule(id);
        await refresh();
        toast.show(t('toast.deleted'), 'success');
      } catch (e) {
        toast.show(e instanceof Error ? e.message : t('toast.error'), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const createReserve = useCallback<LedgerContextValue['createReserve']>(
    async (input) => {
      try {
        await repo.createReserve(input);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(e instanceof Error ? e.message : t('toast.error'), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const removeReserve = useCallback<LedgerContextValue['removeReserve']>(
    async (id) => {
      try {
        await repo.deleteReserve(id);
        await refresh();
        toast.show(t('toast.deleted'), 'success');
      } catch (e) {
        toast.show(e instanceof Error ? e.message : t('toast.error'), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const saveTag = useCallback<LedgerContextValue['saveTag']>(
    async (tag) => {
      try {
        await repo.upsertTag(tag);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(e instanceof Error ? e.message : t('toast.error'), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const removeTag = useCallback<LedgerContextValue['removeTag']>(
    async (id) => {
      try {
        await repo.deleteTag(id);
        await refresh();
        toast.show(t('toast.deleted'), 'success');
      } catch (e) {
        toast.show(e instanceof Error ? e.message : t('toast.error'), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const createAdjustment = useCallback<LedgerContextValue['createAdjustment']>(
    async (input) => {
      try {
        const entry = await repo.createAdjustment(input);
        await refresh();
        if (entry) toast.show(t('toast.saved'), 'success');
        else toast.show(t('adjust.noChange'), 'info');
      } catch (e) {
        toast.show(e instanceof Error ? e.message : t('toast.error'), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const saveAccount = useCallback<LedgerContextValue['saveAccount']>(
    async (account) => {
      try {
        await repo.upsertAccount(account);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(e instanceof Error ? e.message : t('toast.error'), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const removeAccount = useCallback<LedgerContextValue['removeAccount']>(
    async (id) => {
      try {
        await repo.deleteAccount(id);
        await refresh();
        toast.show(t('toast.deleted'), 'success');
      } catch (e) {
        const msg = e instanceof Error ? e.message : t('toast.error');
        toast.show(msg, 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const saveSettings = useCallback<LedgerContextValue['saveSettings']>(
    async (settings) => {
      try {
        await repo.updateSettings(settings);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(t('toast.error'), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const exportJson = useCallback<LedgerContextValue['exportJson']>(() => {
    if (!ledger) return;
    try {
      const text = exportToJsonText(ledger);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob); // 同一オリジンの blob: URL（外部送信なし）
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFileName(ledger);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.show(t('toast.exported'), 'success');
    } catch (e) {
      toast.show(t('toast.error'), 'error');
      throw e;
    }
  }, [ledger, toast]);

  const importJson = useCallback<LedgerContextValue['importJson']>(
    async (text, force) => {
      const outcome = await importFromJsonText(text, { force: force ?? false });
      if (outcome.kind === 'ok') {
        setLedger(outcome.ledger);
        toast.show(
          t('import.success', {
            accounts: outcome.counts.accounts,
            entries: outcome.counts.entries,
          }),
          'success',
        );
      }
      return outcome;
    },
    [toast],
  );

  const listSnapshots = useCallback<LedgerContextValue['listSnapshots']>(() => {
    return repo.listSnapshots();
  }, []);

  const restoreSnapshot = useCallback<LedgerContextValue['restoreSnapshot']>(
    async (snapshot) => {
      try {
        const next = await restoreFromSnapshot(snapshot.data);
        setLedger(next);
        toast.show(t('toast.restored'), 'success');
      } catch (e) {
        toast.show(t('toast.error'), 'error');
        throw e;
      }
    },
    [toast],
  );

  const deleteSnapshot = useCallback<LedgerContextValue['deleteSnapshot']>(async (id) => {
    await repo.deleteSnapshot(id);
  }, []);

  const resetAll = useCallback<LedgerContextValue['resetAll']>(async () => {
    try {
      await repo.resetAll();
      await refresh();
      toast.show(t('toast.reset'), 'success');
    } catch (e) {
      toast.show(t('toast.error'), 'error');
      throw e;
    }
  }, [refresh, toast]);

  const value = useMemo<LedgerContextValue>(
    () => ({
      status,
      ledger,
      ...(error !== undefined ? { error } : {}),
      refresh,
      saveEntry,
      removeEntry,
      createAllocation,
      saveSchedules,
      postSchedule,
      removeSchedule,
      createReserve,
      removeReserve,
      saveTag,
      removeTag,
      createAdjustment,
      saveAccount,
      removeAccount,
      saveSettings,
      exportJson,
      importJson,
      listSnapshots,
      restoreSnapshot,
      deleteSnapshot,
      resetAll,
    }),
    [
      status,
      ledger,
      error,
      refresh,
      saveEntry,
      removeEntry,
      createAllocation,
      saveSchedules,
      postSchedule,
      removeSchedule,
      createReserve,
      removeReserve,
      saveTag,
      removeTag,
      createAdjustment,
      saveAccount,
      removeAccount,
      saveSettings,
      exportJson,
      importJson,
      listSnapshots,
      restoreSnapshot,
      deleteSnapshot,
      resetAll,
    ],
  );

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>;
}

export function useLedger(): LedgerContextValue {
  const ctx = useContext(LedgerContext);
  if (!ctx) throw new Error('useLedger must be used within LedgerProvider');
  return ctx;
}
