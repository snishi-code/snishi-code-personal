/*
 * アプリ状態の単一ソース。IndexedDB(repository) を包み、画面へ ledger と操作を配る。
 * 成功は toast、失敗は error toast + 例外で通知する（保存失敗時に成功 toast を出さない）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  Account,
  Ledger,
  MonthlyCostItem,
  RecurringRule,
  Settings,
  Snapshot,
} from '../domain/types';
import { buildSimpleEntry, type SimpleEntryInput } from '../domain/entry';
import * as repo from '../data/repository';
import { isDefaultSeedAccounts, isDefaultSettings } from '../data/seed';
import type {
  ContinuousCostInput,
  LoanPurchaseInput,
  MonthlyCostArchiveInput,
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
import { clearOnboardingDone } from '../data/localFlags';
import { errorText, t } from '../i18n';
import { LedgerError } from '../domain/errors';

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
    l.monthlyCostItems.length === 0 &&
    isDefaultSettings(l.settings) &&
    isDefaultSeedAccounts(l.accounts)
  );
}

interface LedgerContextValue {
  status: 'loading' | 'ready' | 'error';
  ledger: Ledger | null;
  error?: string;
  /** 起動失敗の LedgerError コード（復旧画面が版不一致の専用導線を出す判定に使う）。 */
  errorCode?: string;
  refresh: () => Promise<void>;
  saveEntry: (
    input: SimpleEntryInput,
    existing?: { id: string; createdAt: string },
  ) => Promise<void>;
  removeEntry: (id: string, description: string) => Promise<void>;
  /** 継続コスト資産の登録（購入の仕訳 + item を 1 tx で。creditAccountId 未指定 = 持ち込み）。 */
  createContinuousCost: (input: ContinuousCostInput) => Promise<void>;
  /** ローンで払う（負債科目 + 購入の仕訳 + 返済ルール、任意で持ち物を 1 tx で）。 */
  createLoanPurchase: (input: LoanPurchaseInput) => Promise<void>;
  saveMonthlyCost: (item: MonthlyCostItem) => Promise<void>;
  removeMonthlyCost: (id: string) => Promise<void>;
  /** アーカイブ = 終了日の設定（+ 残存価値の回収の振替を同一 tx で任意に）。 */
  archiveMonthlyCost: (input: MonthlyCostArchiveInput) => Promise<void>;
  /** 定期ルール（作成/変更後は経過分を即キャッチアップ起票する）。 */
  createRecurringRule: (input: repo.RecurringRuleInput) => Promise<void>;
  saveRecurringRule: (
    rule: RecurringRule,
    options?: repo.RecurringRuleSaveOptions,
  ) => Promise<void>;
  removeRecurringRule: (id: string) => Promise<void>;
  /** 切り替え/終了 + 清算（v13）: 旧線分の終了・後継の開始・配分中 item の清算を 1 tx で。 */
  switchRecurringRule: (input: repo.RecurringRuleSwitchInput) => Promise<void>;
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
  archiveAccount: (
    id: string,
    transferEntry?: Parameters<typeof repo.archiveAccount>[1],
  ) => Promise<void>;
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
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);

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
    setErrorCode(undefined);
    setStatus('ready');
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        // v13: 起動時のキャッチアップ起票は存在しない。ルール由来は読み取り時に導出する。
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
          // LedgerError（schemaVersion 不一致など）は i18n 文言で復旧画面に出す。
          setError(errorText(e));
          setErrorCode(e instanceof LedgerError ? e.code : undefined);
          setStatus('error');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [toast]);

  /**
   * mutation → refresh → 通知の共通経路（fail-closed の単一実装・監査 A）。
   *  - 保存境界そのものの失敗 = 「未保存」: error toast + throw。呼び出し側（確認ダイアログ /
   *    シート）は**閉じずに**再試行できる。
   *  - durable 境界の後の refresh 失敗 = 「保存済み・表示が古いだけ」: 警告 toast のみで
   *    throw しない（「未保存」に見せると再送 = 二重実行を誘発する）。
   * success が null を返す操作は成功 toast を出さない（並び替えなど連続操作を妨げない）。
   */
  const runMutation = useCallback(
    async <T,>(
      mutate: () => Promise<T>,
      success: (result: T) => { message: string; kind?: 'success' | 'info' } | null = () => ({
        message: t('toast.saved'),
      }),
    ): Promise<T> => {
      let result: T;
      try {
        result = await mutate();
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
      try {
        await refresh();
      } catch {
        toast.show(t('toast.savedFollowupFailed'), 'error');
        return result;
      }
      const notice = success(result);
      if (notice) toast.show(notice.message, notice.kind ?? 'success');
      return result;
    },
    [refresh, toast],
  );

  const saveEntry = useCallback<LedgerContextValue['saveEntry']>(
    async (input, existing) => {
      await runMutation(() => {
        // 入力の組み立て失敗（検証）も「未保存」として同じ経路で通知する。
        const entry = buildSimpleEntry(input, existing);
        return repo.upsertEntry(entry);
      });
    },
    [runMutation],
  );

  const removeEntry = useCallback<LedgerContextValue['removeEntry']>(
    async (id) => {
      await runMutation(
        () => repo.deleteEntry(id),
        () => ({ message: t('toast.deleted') }),
      );
    },
    [runMutation],
  );

  const saveMonthlyCost = useCallback<LedgerContextValue['saveMonthlyCost']>(
    async (item) => {
      await runMutation(() => repo.upsertMonthlyCost(item));
    },
    [runMutation],
  );

  const removeMonthlyCost = useCallback<LedgerContextValue['removeMonthlyCost']>(
    async (id) => {
      await runMutation(
        () => repo.deleteMonthlyCost(id),
        () => ({ message: t('toast.deleted') }),
      );
    },
    [runMutation],
  );

  const createContinuousCost = useCallback<LedgerContextValue['createContinuousCost']>(
    async (input) => {
      await runMutation(() => repo.createContinuousCost(input));
    },
    [runMutation],
  );

  const createLoanPurchase = useCallback<LedgerContextValue['createLoanPurchase']>(
    async (input) => {
      await runMutation(() => repo.createLoanPurchase(input));
    },
    [runMutation],
  );

  const archiveMonthlyCost = useCallback<LedgerContextValue['archiveMonthlyCost']>(
    async (input) => {
      await runMutation(() => repo.archiveMonthlyCost(input));
    },
    [runMutation],
  );

  const createRecurringRule = useCallback<LedgerContextValue['createRecurringRule']>(
    async (input) => {
      await runMutation(() => repo.createRecurringRule(input));
    },
    [runMutation],
  );

  const saveRecurringRule = useCallback<LedgerContextValue['saveRecurringRule']>(
    async (rule, options) => {
      await runMutation(() => repo.upsertRecurringRule(rule, options));
    },
    [runMutation],
  );

  const removeRecurringRule = useCallback<LedgerContextValue['removeRecurringRule']>(
    async (id) => {
      await runMutation(
        () => repo.deleteRecurringRule(id),
        () => ({ message: t('toast.deleted') }),
      );
    },
    [runMutation],
  );

  const switchRecurringRule = useCallback<LedgerContextValue['switchRecurringRule']>(
    async (input) => {
      await runMutation(() => repo.switchRecurringRule(input));
    },
    [runMutation],
  );
  const createAdjustment = useCallback<LedgerContextValue['createAdjustment']>(
    async (input) => {
      await runMutation(
        () => repo.createAdjustment(input),
        (entry) =>
          entry ? { message: t('toast.saved') } : { message: t('adjust.noChange'), kind: 'info' },
      );
    },
    [runMutation],
  );

  const updateAdjustment = useCallback<LedgerContextValue['updateAdjustment']>(
    async (input) => {
      await runMutation(
        () => repo.updateAdjustment(input),
        (entry) =>
          entry
            ? { message: t('toast.saved') }
            : { message: t('adjust.removedZero'), kind: 'info' },
      );
    },
    [runMutation],
  );

  const deleteAdjustment = useCallback<LedgerContextValue['deleteAdjustment']>(
    async (id) => {
      await runMutation(
        () => repo.deleteAdjustment(id),
        () => ({ message: t('adjust.deleted') }),
      );
    },
    [runMutation],
  );

  const createOpening = useCallback<LedgerContextValue['createOpening']>(
    async (input) => {
      await runMutation(() => repo.createOpening(input));
    },
    [runMutation],
  );

  const createOpenings = useCallback<LedgerContextValue['createOpenings']>(
    async (inputs) => {
      try {
        await repo.createOpenings(inputs);
      } catch (e) {
        // 一括登録は途中まで保存され得るので、失敗時も表示を最新へ寄せる（best-effort）。
        await refresh().catch(() => undefined);
        toast.show(errorText(e), 'error');
        throw e;
      }
      try {
        await refresh();
      } catch {
        toast.show(t('toast.savedFollowupFailed'), 'error');
        return;
      }
      toast.show(t('toast.saved'), 'success');
    },
    [refresh, toast],
  );

  const updateOpening = useCallback<LedgerContextValue['updateOpening']>(
    async (input) => {
      await runMutation(() => repo.updateOpening(input));
    },
    [runMutation],
  );

  const deleteOpening = useCallback<LedgerContextValue['deleteOpening']>(
    async (id) => {
      await runMutation(
        () => repo.deleteOpening(id),
        () => ({ message: t('opening.deleted') }),
      );
    },
    [runMutation],
  );

  const saveAccount = useCallback<LedgerContextValue['saveAccount']>(
    async (account, opts) => {
      await runMutation(() => repo.upsertAccount(account, opts));
    },
    [runMutation],
  );

  const archiveAccount = useCallback<LedgerContextValue['archiveAccount']>(
    async (id, transferEntry) => {
      await runMutation(() => repo.archiveAccount(id, transferEntry));
    },
    [runMutation],
  );

  const reorderAccounts = useCallback<LedgerContextValue['reorderAccounts']>(
    async (ids) => {
      // toast は出さない＝連続操作を妨げない（成功通知なしは従来どおり）。
      await runMutation(
        () => repo.reorderAccounts(ids),
        () => null,
      );
    },
    [runMutation],
  );

  const removeAccount = useCallback<LedgerContextValue['removeAccount']>(
    async (id) => {
      await runMutation(
        () => repo.deleteAccount(id),
        () => ({ message: t('toast.deleted') }),
      );
    },
    [runMutation],
  );

  const saveSettings = useCallback<LedgerContextValue['saveSettings']>(
    async (settings) => {
      await runMutation(() => repo.updateSettings(settings));
    },
    [runMutation],
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
      // export は書き出し前に schema 検証で throw し得る。原因（どの項目が不正か）を出す。
      toast.show(errorText(e), 'error');
      throw e;
    }
  }, [ledger, toast]);

  const importJson = useCallback<LedgerContextValue['importJson']>(
    async (text, force) => {
      const outcome = await importFromJsonText(text, { force: force ?? false });
      if (outcome.kind === 'ok') {
        applyRecoveredLedger(outcome.ledger);
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
        const next = await restoreFromSnapshot(snapshot.data);
        applyRecoveredLedger(next);
        toast.show(t('toast.restored'), 'success');
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
    },
    [applyRecoveredLedger, toast],
  );

  const deleteSnapshot = useCallback<LedgerContextValue['deleteSnapshot']>(
    async (id) => {
      // ledger 本体は変わらないので refresh は不要（一覧は呼び出し側が読み直す）。
      // 失敗の無通知（監査 A で唯一の toast なし箇所）をここで塞ぐ。
      try {
        await repo.deleteSnapshot(id);
      } catch (e) {
        toast.show(errorText(e), 'error');
        throw e;
      }
      toast.show(t('toast.deleted'), 'success');
    },
    [toast],
  );

  const resetAll = useCallback<LedgerContextValue['resetAll']>(async () => {
    await runMutation(
      async () => {
        await repo.resetAll();
        // 初期状態へ戻すので、オンボーディング既読フラグも消す（次回起動で再表示）。
        clearOnboardingDone();
      },
      () => ({ message: t('toast.reset') }),
    );
  }, [runMutation]);

  const value = useMemo<LedgerContextValue>(
    () => ({
      status,
      ledger,
      ...(error !== undefined ? { error } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
      refresh,
      saveEntry,
      removeEntry,
      createContinuousCost,
      createLoanPurchase,
      saveMonthlyCost,
      removeMonthlyCost,
      archiveMonthlyCost,
      createRecurringRule,
      saveRecurringRule,
      removeRecurringRule,
      switchRecurringRule,
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
      errorCode,
      refresh,
      saveEntry,
      removeEntry,
      createContinuousCost,
      createLoanPurchase,
      saveMonthlyCost,
      removeMonthlyCost,
      archiveMonthlyCost,
      createRecurringRule,
      saveRecurringRule,
      removeRecurringRule,
      switchRecurringRule,
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

/**
 * Provider 外では null を返す読み取り専用版（テストが表示部品を直接描画する場合用）。
 * 実アプリの画面は常に LedgerProvider 配下で描画される。
 */
export function useOptionalLedger(): LedgerContextValue | null {
  return useContext(LedgerContext);
}
