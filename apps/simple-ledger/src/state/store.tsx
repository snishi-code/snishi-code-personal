/*
 * アプリ状態の単一ソース。IndexedDB(repository) を包み、画面へ ledger と操作を配る。
 * 成功は toast、失敗は error toast + 例外で通知する（保存失敗時に成功 toast を出さない）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  Account,
  CashflowSchedule,
  Ledger,
  MonthlyCostItem,
  RecurringRule,
  Settings,
  Snapshot,
  Tag,
} from '../domain/types';
import { buildSimpleEntry, type SimpleEntryInput } from '../domain/entry';
import * as repo from '../data/repository';
import { isDefaultSeedAccounts, isDefaultSettings } from '../data/seed';
import type { ContinuousCostInput, MonthlyCostArchiveInput } from '../data/repository';
import {
  exportFileName,
  exportToJsonText,
  importFromJsonText,
  loadSampleFixture,
  restoreFromSnapshot,
  type ImportOutcome,
} from '../data/exportImport';
import { useToast } from '@snishi/foundation/ui/toast';
import { clearOnboardingDone } from '../data/localFlags';
import { todayLocal } from '../util/time';
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
 * フィクスチャ投入と初回オンボーディング自動表示の安全判定に使う。
 * 科目だけ整理した／設定を変えた台帳は「初期状態」と見なさない。
 */
export function isPristineSeedLedger(l: Ledger): boolean {
  return (
    l.journalEntries.length === 0 &&
    l.cashflowSchedules.length === 0 &&
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
  removeEntry: (id: string, description: string) => Promise<void>;
  /** 継続コスト資産の登録（購入の仕訳 + item を 1 tx で。creditAccountId 未指定 = 持ち込み）。 */
  createContinuousCost: (input: ContinuousCostInput) => Promise<void>;
  createRepaymentEntries: (input: repo.RepaymentPlanInput) => Promise<void>;
  saveMonthlyCost: (item: MonthlyCostItem) => Promise<void>;
  removeMonthlyCost: (id: string) => Promise<void>;
  /** アーカイブ = 終了日の設定（+ 残存価値の回収の振替を同一 tx で任意に）。 */
  archiveMonthlyCost: (input: MonthlyCostArchiveInput) => Promise<void>;
  saveSchedules: (schedules: CashflowSchedule[]) => Promise<void>;
  postSchedule: (id: string) => Promise<void>;
  removeSchedule: (id: string) => Promise<void>;
  /** 定期ルール（作成/変更後は経過分を即キャッチアップ起票する）。 */
  createRecurringRule: (input: repo.RecurringRuleInput) => Promise<void>;
  saveRecurringRule: (rule: RecurringRule) => Promise<void>;
  /** 停止/再開（再開は位相を保ち、停止中の月を遡って起票しない）。 */
  setRecurringRulePaused: (id: string, paused: boolean) => Promise<void>;
  removeRecurringRule: (id: string) => Promise<void>;
  saveTag: (tag: Tag) => Promise<void>;
  removeTag: (id: string) => Promise<void>;
  createAdjustment: (input: {
    accountId: string;
    date: string;
    actualBalance: number;
    description?: string;
  }) => Promise<void>;
  updateAdjustment: (input: {
    id: string;
    accountId: string;
    date: string;
    actualBalance: number;
    description?: string;
  }) => Promise<void>;
  deleteAdjustment: (id: string) => Promise<void>;
  createOpening: (input: repo.OpeningInput) => Promise<void>;
  /** 初期残高の一括登録（オンボーディング用。成功 toast は 1 回に集約）。 */
  createOpenings: (inputs: repo.OpeningInput[]) => Promise<void>;
  updateOpening: (input: { id: string; amount: number; date: string }) => Promise<void>;
  deleteOpening: (id: string) => Promise<void>;
  saveAccount: (account: Account, opts?: repo.AccountSaveOptions) => Promise<void>;
  /** アーカイブ（残高が残る資産・負債は振替仕訳を同一 tx で保存して 0 にしてから）。 */
  archiveAccount: (id: string, transferEntry?: Parameters<typeof repo.archiveAccount>[1]) => Promise<void>;
  /** 科目の表示順を保存（並び替え。toast は出さない＝連続操作を妨げない）。 */
  reorderAccounts: (ids: string[]) => Promise<void>;
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

  /**
   * 復旧経路（JSON 取り込み・スナップショット復元）の結果を反映する。status/error も戻すのが要点:
   * 戻さないと「起動に失敗 → 復旧画面から取り込み → データは入ったのに画面はエラーのまま」になる。
   */
  const applyRecoveredLedger = useCallback((next: Ledger) => {
    setLedger(next);
    setError(undefined);
    setStatus('ready');
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        // 定期ルールの経過分をキャッチアップ起票してから読み込む（GnuCash の Since-Last-Run 同型）。
        // 起票に失敗してもアプリは開く（fail-soft）。
        try {
          await repo.catchUpRecurringRules(todayLocal());
        } catch {
          // 破損ルール等。台帳表示は続行する。
        }
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

  const createRepaymentEntries = useCallback<LedgerContextValue['createRepaymentEntries']>(
    async (input) => {
      try {
        await repo.createRepaymentEntries(input);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const archiveMonthlyCost = useCallback<LedgerContextValue['archiveMonthlyCost']>(
    async (input) => {
      try {
        await repo.archiveMonthlyCost(input);
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

  const createRecurringRule = useCallback<LedgerContextValue['createRecurringRule']>(
    async (input) => {
      try {
        await repo.createRecurringRule(input);
        // 開始月が過去〜当月なら、その場で経過分を起票する（登録直後に仕訳が見える）。
        await repo.catchUpRecurringRules(todayLocal());
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const saveRecurringRule = useCallback<LedgerContextValue['saveRecurringRule']>(
    async (rule) => {
      try {
        await repo.upsertRecurringRule(rule);
        await repo.catchUpRecurringRules(todayLocal());
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const setRecurringRulePaused = useCallback<LedgerContextValue['setRecurringRulePaused']>(
    async (id, paused) => {
      try {
        await repo.setRecurringRulePaused(id, paused);
        // 再開直後の当月分を経過起票する（停止は起票を止めるだけなので catchUp は無害）。
        await repo.catchUpRecurringRules(todayLocal());
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const removeRecurringRule = useCallback<LedgerContextValue['removeRecurringRule']>(
    async (id) => {
      try {
        await repo.deleteRecurringRule(id);
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

  const createOpenings = useCallback<LedgerContextValue['createOpenings']>(
    async (inputs) => {
      try {
        await repo.createOpenings(inputs);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        await refresh();
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

  const archiveAccount = useCallback<LedgerContextValue['archiveAccount']>(
    async (id, transferEntry) => {
      try {
        await repo.archiveAccount(id, transferEntry);
        await refresh();
        toast.show(t('toast.saved'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [refresh, toast],
  );

  const reorderAccounts = useCallback<LedgerContextValue['reorderAccounts']>(
    async (ids) => {
      try {
        await repo.reorderAccounts(ids);
        await refresh();
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
        // 取り込んだ定期ルールの経過分を起票してから表示する（失敗しても import は成立）。
        let latest = outcome.ledger;
        try {
          await repo.catchUpRecurringRules(todayLocal());
          latest = await repo.loadLedger();
        } catch {
          // fail-soft
        }
        applyRecoveredLedger(latest);
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
    [applyRecoveredLedger, toast],
  );

  const listSnapshots = useCallback<LedgerContextValue['listSnapshots']>(() => {
    return repo.listSnapshots();
  }, []);

  const restoreSnapshot = useCallback<LedgerContextValue['restoreSnapshot']>(
    async (snapshot) => {
      try {
        let next = await restoreFromSnapshot(snapshot.data);
        // 復元した定期ルールの経過分を起票（失敗しても復元は成立）。
        try {
          await repo.catchUpRecurringRules(todayLocal());
          next = await repo.loadLedger();
        } catch {
          // fail-soft
        }
        applyRecoveredLedger(next);
        toast.show(t('toast.restored'), 'success');
      } catch (e) {
        toast.show(t('toast.error'), 'error');
        throw e;
      }
    },
    [applyRecoveredLedger, toast],
  );

  const deleteSnapshot = useCallback<LedgerContextValue['deleteSnapshot']>(async (id) => {
    await repo.deleteSnapshot(id);
  }, []);

  const resetAll = useCallback<LedgerContextValue['resetAll']>(async () => {
    try {
      await repo.resetAll();
      // 初期状態へ戻すので、オンボーディング既読フラグも消す（次回起動で再表示）。
      clearOnboardingDone();
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
      createContinuousCost,
      createRepaymentEntries,
      saveMonthlyCost,
      removeMonthlyCost,
      archiveMonthlyCost,
      saveSchedules,
      postSchedule,
      removeSchedule,
      createRecurringRule,
      saveRecurringRule,
      setRecurringRulePaused,
      removeRecurringRule,
      saveTag,
      removeTag,
      createAdjustment,
      updateAdjustment,
      deleteAdjustment,
      createOpening,
      createOpenings,
      updateOpening,
      deleteOpening,
      saveAccount,
      archiveAccount,
      reorderAccounts,
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
      createContinuousCost,
      createRepaymentEntries,
      saveMonthlyCost,
      removeMonthlyCost,
      archiveMonthlyCost,
      saveSchedules,
      postSchedule,
      removeSchedule,
      createRecurringRule,
      saveRecurringRule,
      setRecurringRulePaused,
      removeRecurringRule,
      saveTag,
      removeTag,
      createAdjustment,
      updateAdjustment,
      deleteAdjustment,
      createOpening,
      createOpenings,
      updateOpening,
      deleteOpening,
      saveAccount,
      archiveAccount,
      reorderAccounts,
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
