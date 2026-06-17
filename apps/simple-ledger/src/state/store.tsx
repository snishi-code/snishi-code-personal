/*
 * アプリ状態の単一ソース。IndexedDB(repository) を包み、画面へ ledger と操作を配る。
 * 成功は toast、失敗は error toast + 例外で通知する（保存失敗時に成功 toast を出さない）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  Account,
  AccountInstrument,
  AdjustmentKind,
  CashflowSchedule,
  Ledger,
  ManagementScope,
  MonthlyCostItem,
  ReserveItem,
  Settings,
  Snapshot,
  Tag,
} from '../domain/types';
import { buildSimpleEntry, type SimpleEntryInput } from '../domain/entry';
import type { AllocationInput } from '../domain/allocation';
import * as repo from '../data/repository';
import { isDefaultSeedAccounts, isDefaultSettings } from '../data/seed';
import type {
  AccountInstrumentInput,
  ContinuousCostInput,
  DisposeFixedAssetInput,
  FixedAssetMonthlyInput,
  FixedAssetPurchaseMonthlyInput,
  MonthlyCostInput,
} from '../data/repository';
import {
  exportFileName,
  exportToJsonText,
  importFromJsonText,
  loadSampleFixture,
  restoreFromSnapshot,
  type ImportOutcome,
} from '../data/exportImport';
import { useToast } from '@snishi/foundation/ui/toast';
import { errorText, t } from '../i18n';

/** `?fixture=sample` が指定されているか（手動テスト用。本番通常起動では false）。 */
function sampleFixtureRequested(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('fixture') === 'sample';
  } catch {
    return false;
  }
}

/**
 * 完全に初期 seed 状態か（ユーザーデータ皆無 + 既定科目・既定設定そのまま）。
 * フィクスチャ投入の安全判定に使う。科目だけ整理した／設定を変えた台帳は上書きしない。
 */
function isPristineSeedLedger(l: Ledger): boolean {
  return (
    l.journalEntries.length === 0 &&
    l.allocations.length === 0 &&
    l.cashflowSchedules.length === 0 &&
    l.reserves.length === 0 &&
    l.monthlyCostItems.length === 0 &&
    l.tags.length === 0 &&
    isDefaultSettings(l.settings) &&
    isDefaultSeedAccounts(l.accounts)
  );
}

interface LedgerContextValue {
  status: 'loading' | 'ready' | 'error';
  ledger: Ledger | null;
  error?: string;
  refresh: () => Promise<void>;
  saveEntry: (
    input: SimpleEntryInput,
    existing?: { id: string; createdAt: string },
  ) => Promise<void>;
  saveEntryWithSchedules: (input: SimpleEntryInput, schedules: CashflowSchedule[]) => Promise<void>;
  saveEntryWithFixedAssetMonthly: (
    input: SimpleEntryInput,
    monthly: FixedAssetMonthlyInput,
  ) => Promise<void>;
  removeEntry: (id: string, description: string) => Promise<void>;
  createAllocation: (input: Omit<AllocationInput, 'deferredAccountId'>) => Promise<void>;
  createMonthlyCost: (input: MonthlyCostInput) => Promise<void>;
  createContinuousCost: (input: ContinuousCostInput) => Promise<void>;
  saveMonthlyCost: (item: MonthlyCostItem) => Promise<void>;
  removeMonthlyCost: (id: string) => Promise<void>;
  createFixedAssetPurchaseMonthly: (input: FixedAssetPurchaseMonthlyInput) => Promise<void>;
  disposeFixedAsset: (input: DisposeFixedAssetInput) => Promise<void>;
  disposeContinuousCost: (input: DisposeFixedAssetInput) => Promise<void>;
  saveSchedules: (schedules: CashflowSchedule[]) => Promise<void>;
  postSchedule: (id: string) => Promise<void>;
  removeSchedule: (id: string) => Promise<void>;
  createReserve: (input: {
    name: string;
    note?: string;
    parentAccountId?: string;
  }) => Promise<ReserveItem>;
  removeReserve: (id: string) => Promise<void>;
  saveTag: (tag: Tag) => Promise<void>;
  removeTag: (id: string) => Promise<void>;
  createManagementScope: (name: string) => Promise<ManagementScope>;
  saveManagementScope: (scope: ManagementScope) => Promise<void>;
  removeManagementScope: (id: string) => Promise<void>;
  createAccountInstrument: (input: AccountInstrumentInput) => Promise<AccountInstrument>;
  saveAccountInstrument: (instrument: AccountInstrument) => Promise<void>;
  removeAccountInstrument: (id: string) => Promise<void>;
  createAdjustment: (input: {
    kind: AdjustmentKind;
    accountId: string;
    date: string;
    actualBalance: number;
    description?: string;
  }) => Promise<void>;
  updateAdjustment: (input: {
    id: string;
    kind: AdjustmentKind;
    accountId: string;
    date: string;
    actualBalance: number;
    description?: string;
  }) => Promise<void>;
  deleteAdjustment: (id: string) => Promise<void>;
  createOpening: (input: repo.OpeningInput) => Promise<void>;
  updateOpening: (input: { id: string; amount: number; date: string }) => Promise<void>;
  deleteOpening: (id: string) => Promise<void>;
  saveAccount: (account: Account, opts?: repo.AccountSaveOptions) => Promise<void>;
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
        let next = await repo.loadLedger();
        if (sampleFixtureRequested() && isPristineSeedLedger(next)) {
          next = await loadSampleFixture();
        }
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
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const saveEntryWithSchedules = useCallback<LedgerContextValue['saveEntryWithSchedules']>(
    async (input, schedules) => {
      try {
        const entry = buildSimpleEntry(input);
        await repo.saveEntryWithSchedules(entry, schedules);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const saveEntryWithFixedAssetMonthly = useCallback<
    LedgerContextValue['saveEntryWithFixedAssetMonthly']
  >(
    async (input, monthly) => {
      try {
        const entry = buildSimpleEntry(input);
        await repo.saveEntryWithFixedAssetMonthly(entry, monthly);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
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
        toast.show(errorText(e), 'error');
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
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const createMonthlyCost = useCallback<LedgerContextValue['createMonthlyCost']>(
    async (input) => {
      try {
        await repo.createMonthlyCost(input);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const saveMonthlyCost = useCallback<LedgerContextValue['saveMonthlyCost']>(
    async (item) => {
      try {
        await repo.upsertMonthlyCost(item);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const removeMonthlyCost = useCallback<LedgerContextValue['removeMonthlyCost']>(
    async (id) => {
      try {
        await repo.deleteMonthlyCost(id);
        await refresh();
        toast.show(t('toast.deleted'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const createContinuousCost = useCallback<LedgerContextValue['createContinuousCost']>(
    async (input) => {
      try {
        await repo.createContinuousCost(input);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const createFixedAssetPurchaseMonthly = useCallback<
    LedgerContextValue['createFixedAssetPurchaseMonthly']
  >(
    async (input) => {
      try {
        await repo.createFixedAssetPurchaseMonthly(input);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const disposeFixedAsset = useCallback<LedgerContextValue['disposeFixedAsset']>(
    async (input) => {
      try {
        await repo.disposeFixedAsset(input);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const disposeContinuousCost = useCallback<LedgerContextValue['disposeContinuousCost']>(
    async (input) => {
      try {
        await repo.disposeContinuousCost(input);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
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
        toast.show(errorText(e), 'error');
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
        toast.show(errorText(e), 'error');
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
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const createReserve = useCallback<LedgerContextValue['createReserve']>(
    async (input) => {
      try {
        const reserve = await repo.createReserve(input);
        await refresh();
        toast.show(t('toast.saved'), 'success');
        return reserve;
      } catch (e) {
        toast.show(errorText(e), 'error');
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
        toast.show(errorText(e), 'error');
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
        toast.show(errorText(e), 'error');
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
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const createManagementScope = useCallback<LedgerContextValue['createManagementScope']>(
    async (name) => {
      try {
        const scope = await repo.createManagementScope(name);
        await refresh();
        toast.show(t('toast.saved'), 'success');
        return scope;
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const saveManagementScope = useCallback<LedgerContextValue['saveManagementScope']>(
    async (scope) => {
      try {
        await repo.upsertManagementScope(scope);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const removeManagementScope = useCallback<LedgerContextValue['removeManagementScope']>(
    async (id) => {
      try {
        await repo.deleteManagementScope(id);
        await refresh();
        toast.show(t('toast.deleted'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const createAccountInstrument = useCallback<LedgerContextValue['createAccountInstrument']>(
    async (input) => {
      try {
        const inst = await repo.createAccountInstrument(input);
        await refresh();
        toast.show(t('toast.saved'), 'success');
        return inst;
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const saveAccountInstrument = useCallback<LedgerContextValue['saveAccountInstrument']>(
    async (instrument) => {
      try {
        await repo.upsertAccountInstrument(instrument);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const removeAccountInstrument = useCallback<LedgerContextValue['removeAccountInstrument']>(
    async (id) => {
      try {
        await repo.deleteAccountInstrument(id);
        await refresh();
        toast.show(t('toast.deleted'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
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
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const updateAdjustment = useCallback<LedgerContextValue['updateAdjustment']>(
    async (input) => {
      try {
        const entry = await repo.updateAdjustment(input);
        await refresh();
        if (entry) toast.show(t('toast.saved'), 'success');
        else toast.show(t('adjust.removedZero'), 'info');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const deleteAdjustment = useCallback<LedgerContextValue['deleteAdjustment']>(
    async (id) => {
      try {
        await repo.deleteAdjustment(id);
        await refresh();
        toast.show(t('adjust.deleted'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const createOpening = useCallback<LedgerContextValue['createOpening']>(
    async (input) => {
      try {
        await repo.createOpening(input);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const updateOpening = useCallback<LedgerContextValue['updateOpening']>(
    async (input) => {
      try {
        await repo.updateOpening(input);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const deleteOpening = useCallback<LedgerContextValue['deleteOpening']>(
    async (id) => {
      try {
        await repo.deleteOpening(id);
        await refresh();
        toast.show(t('opening.deleted'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const saveAccount = useCallback<LedgerContextValue['saveAccount']>(
    async (account, opts) => {
      try {
        await repo.upsertAccount(account, opts);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
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
        toast.show(errorText(e), 'error');
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
      saveEntryWithSchedules,
      saveEntryWithFixedAssetMonthly,
      removeEntry,
      createAllocation,
      createMonthlyCost,
      createContinuousCost,
      saveMonthlyCost,
      removeMonthlyCost,
      createFixedAssetPurchaseMonthly,
      disposeFixedAsset,
      disposeContinuousCost,
      saveSchedules,
      postSchedule,
      removeSchedule,
      createReserve,
      removeReserve,
      saveTag,
      removeTag,
      createManagementScope,
      saveManagementScope,
      removeManagementScope,
      createAccountInstrument,
      saveAccountInstrument,
      removeAccountInstrument,
      createAdjustment,
      updateAdjustment,
      deleteAdjustment,
      createOpening,
      updateOpening,
      deleteOpening,
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
      saveEntryWithSchedules,
      saveEntryWithFixedAssetMonthly,
      removeEntry,
      createAllocation,
      createMonthlyCost,
      createContinuousCost,
      saveMonthlyCost,
      removeMonthlyCost,
      createFixedAssetPurchaseMonthly,
      disposeFixedAsset,
      disposeContinuousCost,
      saveSchedules,
      postSchedule,
      removeSchedule,
      createReserve,
      removeReserve,
      saveTag,
      removeTag,
      createManagementScope,
      saveManagementScope,
      removeManagementScope,
      createAccountInstrument,
      saveAccountInstrument,
      removeAccountInstrument,
      createAdjustment,
      updateAdjustment,
      deleteAdjustment,
      createOpening,
      updateOpening,
      deleteOpening,
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
