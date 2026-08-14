/*
 * 設定。JSON export/import、スナップショット、全データ削除、アプリ情報、台帳設定。
 * 破壊的操作(import/全削除/復元)は明示確認・背景タップ無効・fail-closed。
 *
 * v2 変更点:
 *  - revision-conflict: importRevision（v1 の baseRevision を廃止）
 *  - unsupported-version: reason enum 廃止 → outcome.detail を直接表示
 *  - useToast: @snishi/foundation/ui/toast
 *  - Icon/ConfirmDialog/TextInput: @snishi/foundation/ui/*
 */
import { startTransition, useEffect, useRef, useState } from 'react';
import { useToast } from '@snishi/foundation/ui/toast';
import { ConfirmDialog } from '../overlays';
import { TextInput } from '@snishi/foundation/ui/Field';
import { Segmented } from '@snishi/foundation/ui/Segmented';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../../state/store';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import {
  CASHFLOW_HORIZON_MAX_MONTHS,
  cashflowHorizonMonths,
  rememberCashflowHorizonMonths,
} from '../../data/localFlags';
import { APP_ID } from '../../domain/constants';
import { MANAGEMENT_ITEMS, type Screen } from '../navigation';
import type { ImportOutcome } from '../../data/exportImport';
import type { Settings as LedgerSettings, Snapshot } from '../../domain/types';
import { ScrollTopButton } from '../ScrollTopButton';

const APP_VERSION = '0.1.0';

export function importErrorMessage(
  outcome: Exclude<ImportOutcome, { kind: 'ok' | 'revision-conflict' }>,
): string {
  switch (outcome.kind) {
    case 'parse-error':
      return t('import.error.parse');
    case 'not-our-file':
      return t('import.error.notOurFile');
    case 'validation-error':
      return t('import.error.validation', { detail: outcome.detail });
    case 'unsupported-version':
      // v2: reason enum 廃止。detail 文字列を直接表示する。
      return outcome.detail ?? t('import.error.unknownVersion');
    case 'storage-error':
      // repository が返す既知のエラーコードは翻訳し、IndexedDB 等の具体的な
      // storage error は診断可能な detail をそのまま表示する。
      if (
        outcome.detail === 'error.common.staleData' ||
        outcome.detail === 'error.common.revisionExhausted'
      ) {
        return t(outcome.detail);
      }
      return outcome.detail;
  }
}

/**
 * 入力上限の切り詰め（UTF-16 code unit 基準 = zod の string.max と同じ数え方）。
 * slice がサロゲートペアの途中で切れると孤立サロゲートが保存される（絵文字の単位等）ため、
 * 末尾が high surrogate ならそれごと落とす。
 */
function clampCodeUnits(v: string, max: number): string {
  let out = v.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** スナップショット読込失敗を空一覧へ偽装せず、復旧データを触らないよう明示する。 */
export function snapshotListErrorMessage(): string {
  return t('snapshot.loadError');
}

/**
 * スナップショット理由コード → 表示文言。未知コードはそのまま出す（fail-visible）。
 * v11 から reason は理由コード（'import'/'restore'）を保存する（生文言を保存しない）。
 */
function snapshotReasonLabel(reason: string): string {
  switch (reason) {
    case 'import':
      return t('snapshot.reason.import');
    case 'restore':
      return t('snapshot.reason.restore');
    default:
      return reason;
  }
}

export function Settings({
  onNavigate,
  onOpenOnboarding,
}: {
  onNavigate: (screen: Screen) => void;
  /** 初期残高の一括登録シートを開く（初回オンボーディングの再表示導線）。 */
  onOpenOnboarding: () => void;
}) {
  const {
    ledger,
    exportJson,
    importJson,
    listSnapshots,
    restoreSnapshot,
    deleteSnapshot,
    resetAll,
    saveSettings,
  } = useLedger();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotError, setSnapshotError] = useState<string | undefined>(undefined);
  const [pendingImportText, setPendingImportText] = useState<string | null>(null);
  // v2: importRevision（v1 の baseRevision を廃止）
  const [conflict, setConflict] = useState<{ local: number; import: number } | null>(null);
  const [pendingRestore, setPendingRestore] = useState<Snapshot | null>(null);
  const [pendingDeleteSnap, setPendingDeleteSnap] = useState<Snapshot | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const [ledgerName, setLedgerName] = useState(ledger?.settings.ledgerName ?? '');
  const [currency, setCurrency] = useState(ledger?.settings.currency ?? '');
  // 端末設定（台帳データではない）。確定できる値だけ記憶し、欄には打鍵中の文字列を保つ。
  const [horizonText, setHorizonText] = useState(() => String(cashflowHorizonMonths()));
  const [fractionDigits, setFractionDigits] = useState<0 | 1 | 2>(
    ledger?.settings.displayFractionDigits ?? 0,
  );
  const [settingsErrors, setSettingsErrors] = useState<{
    ledgerName?: string;
    currency?: string;
  }>({});

  const refreshSnapshots = () => {
    listSnapshots()
      .then((next) => {
        setSnapshotError(undefined);
        setSnapshots(next);
      })
      .catch(() => setSnapshotError(snapshotListErrorMessage()));
  };

  useEffect(() => {
    refreshSnapshots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ledger) {
      startTransition(() => {
        setLedgerName(ledger.settings.ledgerName);
        setCurrency(ledger.settings.currency);
        // 初期化（:95-96）と同じく既定 0 で受ける。設定が欠けた台帳でも undefined を state に入れない。
        setFractionDigits(ledger.settings.displayFractionDigits ?? 0);
        setSettingsErrors({});
      });
    }
  }, [ledger]);

  async function runImport(text: string, force: boolean) {
    const outcome = await importJson(text, force);
    if (outcome.kind === 'ok') {
      refreshSnapshots();
      return;
    }
    if (outcome.kind === 'revision-conflict') {
      setPendingImportText(text);
      // v2: importRevision（v1 は baseRevision）
      setConflict({ local: outcome.localRevision, import: outcome.importRevision });
      return;
    }
    toast.show(importErrorMessage(outcome), 'error');
  }

  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      await runImport(text, false);
    } catch {
      toast.show(t('import.error.parse'), 'error');
    }
  }

  function saveLedgerSettings() {
    const normalizedLedgerName = ledgerName.trim();
    const normalizedCurrency = currency.trim();
    const errors = {
      ledgerName: normalizedLedgerName ? undefined : t('settings.ledgerNameRequired'),
      currency: normalizedCurrency ? undefined : t('settings.currencyRequired'),
    };
    if (errors.ledgerName || errors.currency) {
      setSettingsErrors(errors);
      return;
    }
    setSettingsErrors({});
    const next: LedgerSettings = {
      // 空欄を既定値や旧値へ黙って差し替えない。上の検証で明示的に止める。
      ledgerName: normalizedLedgerName,
      currency: normalizedCurrency,
      displayFractionDigits: fractionDigits,
    };
    saveSettings(next).catch(() => undefined);
  }

  return (
    <section aria-labelledby="settings-title" data-ui={UI.settings.view}>
      <h1 className="screen-title" id="settings-title">
        {t('settings.title')}
      </h1>

      {/* 管理（補助画面へ） */}
      <p className="section-label">{t('settings.manageSection')}</p>
      <ul className="card list" data-ui={UI.settings.manageList}>
        {MANAGEMENT_ITEMS.map((item) => (
          <li key={item.screen}>
            <button
              type="button"
              className="list__row-btn"
              onClick={() => onNavigate(item.screen)}
              data-ui={`settings.manage.${item.screen}`}
            >
              <span className="list__row-btn__label">
                <Icon name={item.icon} size={18} />
                {t(item.labelKey)}
              </span>
              <Icon name="chevronRight" size={16} />
            </button>
          </li>
        ))}
      </ul>

      {/* データ */}
      <p className="section-label">{t('settings.dataSection')}</p>
      <div className="card card--pad stack">
        <div>
          <button
            type="button"
            className="btn btn--block"
            onClick={exportJson}
            data-ui={UI.settings.exportJson}
          >
            <Icon name="download" size={18} />
            {t('settings.export')}
          </button>
          <p className="field__hint" style={{ marginTop: 6 }}>
            {t('settings.exportDesc')}
          </p>
        </div>
        <div>
          <button
            type="button"
            className="btn btn--block"
            onClick={() => fileRef.current?.click()}
            data-ui={UI.settings.importJson}
          >
            <Icon name="upload" size={18} />
            {t('settings.import')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={onFileSelected}
            className="sr-only"
            aria-hidden="true"
            tabIndex={-1}
            data-ui={UI.settings.importFile}
          />
          <p className="field__hint" style={{ marginTop: 6 }}>
            {t('settings.importDesc')}
          </p>
          {/* 免責 1 行（§C）: 復旧面（ErrorBoundary が本画面を埋め込む）にも同時に出る。 */}
          <p className="field__hint">{t('settings.importDisclaimer')}</p>
        </div>
        <div>
          <button
            type="button"
            className="btn btn--block"
            onClick={onOpenOnboarding}
            data-ui={UI.settings.onboardingOpen}
          >
            <Icon name="restore" size={18} />
            {t('settings.onboardingOpen')}
          </button>
          <p className="field__hint" style={{ marginTop: 6 }}>
            {t('onboarding.dateHint')}
          </p>
        </div>
      </div>

      {/* スナップショット */}
      <p className="section-label">{t('settings.snapshots')}</p>
      <p className="field__hint" style={{ marginBottom: 8 }}>
        {t('settings.snapshotsDesc')}
      </p>
      {snapshotError ? (
        <div className="field__error" role="alert">
          <Icon name="alert" size={14} />
          {snapshotError}
        </div>
      ) : snapshots.length === 0 ? (
        <div className="card card--pad muted">{t('snapshot.empty')}</div>
      ) : (
        <ul className="card list">
          {snapshots.map((snap) => (
            <li key={snap.id} className="list__item">
              <div className="list__main">
                <div className="list__title">{snapshotReasonLabel(snap.reason)}</div>
                <div className="list__sub">
                  {new Date(snap.createdAt).toLocaleString('ja-JP')}・
                  {t('snapshot.entries', { count: snap.data.journalEntries.length })}
                </div>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setPendingRestore(snap)}
                >
                  <Icon name="restore" size={16} />
                  {t('snapshot.restore')}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setPendingDeleteSnap(snap)}
                  aria-label={`${t('snapshot.delete')}: ${snapshotReasonLabel(snap.reason)}`}
                >
                  <Icon name="delete" size={18} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 台帳設定 */}
      <p className="section-label">{t('settings.about')}</p>
      <div className="card card--pad">
        {/* どちらも空は保存できない（settingsSchema は min(1)）。UI 側でも required を出す。 */}
        <TextInput
          label={t('settings.ledgerName')}
          required
          value={ledgerName}
          onChange={(v) => {
            setLedgerName(clampCodeUnits(v, 120));
            setSettingsErrors((current) => ({ ...current, ledgerName: undefined }));
          }}
          error={settingsErrors.ledgerName}
        />
        <TextInput
          label={t('settings.currency')}
          required
          value={currency}
          onChange={(v) => {
            setCurrency(clampCodeUnits(v, 8));
            setSettingsErrors((current) => ({ ...current, currency: undefined }));
          }}
          hint={t('settings.currencyHint')}
          error={settingsErrors.currency}
        />
        {/* 表示桁数（0|1|2・入力の刻みも連動）。保存・計算は常に 1/100 固定でこの設定では変わらない。 */}
        <div className="field" data-ui={UI.settings.fractionDigits}>
          <span className="field__label">{t('settings.fractionDigits')}</span>
          <span className="field__hint">{t('settings.fractionDigitsHint')}</span>
          <div className="list-sort toolbar" role="group" aria-label={t('settings.fractionDigits')}>
            <Segmented
              value={String(fractionDigits)}
              items={[
                { key: '0', label: '0' },
                { key: '1', label: '1' },
                { key: '2', label: '2' },
              ]}
              onChange={(key) => setFractionDigits(key === '1' ? 1 : key === '2' ? 2 : 0)}
            />
          </div>
        </div>
        <button type="button" className="btn" onClick={saveLedgerSettings}>
          {t('common.save')}
        </button>
        {/* 資金繰りの既定表示期間。台帳データではなく端末の表示の好み（localFlags）なので、
            上の「保存」とは独立に、変更したその場で確定する。資金繰り画面での一時的な
            日付変更は持ち帰らない（次に開くとこの既定へ戻る・作者決定 2026-08-14）。 */}
        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <span className="field__label" id="cashflow-horizon-label">
            {t('settings.cashflowHorizon')}
          </span>
          <span className="field__hint">{t('settings.cashflowHorizonHint')}</span>
          <input
            className="input"
            inputMode="numeric"
            aria-labelledby="cashflow-horizon-label"
            value={horizonText}
            onChange={(e) => {
              const text = e.target.value.replace(/[^\d]/g, '');
              setHorizonText(text);
              const months = Number.parseInt(text, 10);
              if (
                Number.isInteger(months) &&
                months >= 1 &&
                months <= CASHFLOW_HORIZON_MAX_MONTHS
              ) {
                rememberCashflowHorizonMonths(months);
              }
            }}
            data-ui={UI.settings.cashflowHorizon}
          />
        </div>
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div className="kv">
            <span className="muted">{t('settings.version')}</span>
            <span>{APP_VERSION}</span>
          </div>
          <div className="kv">
            <span className="muted">{t('settings.schemaVersion')}</span>
            <span>{ledger?.meta.schemaVersion}</span>
          </div>
          <div className="kv">
            <span className="muted">{t('settings.revision')}</span>
            <span>{ledger?.meta.revision}</span>
          </div>
          <div className="kv">
            <span className="muted">app</span>
            <span style={{ fontSize: 12 }}>{APP_ID}</span>
          </div>
        </div>
        <p className="field__hint" style={{ marginTop: 'var(--space-3)' }}>
          <Icon name="check" size={14} /> {t('settings.offlineNote')}
        </p>
      </div>

      {/* 全データ削除 */}
      <p className="section-label">{t('settings.resetAll')}</p>
      <div className="card card--pad">
        <p className="field__hint" style={{ marginBottom: 8 }}>
          {t('settings.resetAllDesc')}
        </p>
        <button
          type="button"
          className="btn btn--danger btn--block"
          onClick={() => setConfirmReset(true)}
          data-ui={UI.settings.resetAll}
        >
          <Icon name="delete" size={18} />
          {t('settings.resetAll')}
        </button>
      </div>

      {/* ダイアログ群 */}
      {conflict && pendingImportText ? (
        <ConfirmDialog
          title={t('import.conflictTitle')}
          body={t('import.conflictBody', { local: conflict.local, base: conflict.import })}
          confirmLabel={t('common.proceed')}
          danger
          dataUi={UI.dialog.confirm}
          onCancel={() => {
            setConflict(null);
            setPendingImportText(null);
          }}
          onConfirm={async () => {
            const text = pendingImportText;
            setConflict(null);
            setPendingImportText(null);
            if (text) await runImport(text, true);
          }}
        />
      ) : null}

      {pendingRestore ? (
        <ConfirmDialog
          title={t('snapshot.restoreConfirmTitle')}
          body={t('snapshot.restoreConfirmBody')}
          confirmLabel={t('snapshot.restore')}
          onCancel={() => setPendingRestore(null)}
          onConfirm={async () => {
            const snap = pendingRestore;
            setPendingRestore(null);
            await restoreSnapshot(snap).catch(() => undefined);
            refreshSnapshots();
          }}
        />
      ) : null}

      {pendingDeleteSnap ? (
        <ConfirmDialog
          title={t('snapshot.delete')}
          body={snapshotReasonLabel(pendingDeleteSnap.reason)}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingDeleteSnap(null)}
          onConfirm={async () => {
            const snap = pendingDeleteSnap;
            setPendingDeleteSnap(null);
            await deleteSnapshot(snap.id).catch(() => undefined);
            refreshSnapshots();
          }}
        />
      ) : null}

      {confirmReset ? (
        <ConfirmDialog
          title={t('reset.confirmTitle')}
          body={t('reset.confirmBody')}
          confirmLabel={t('settings.resetAll')}
          danger
          requireKeyword={t('reset.keyword')}
          onCancel={() => setConfirmReset(false)}
          onConfirm={async () => {
            setConfirmReset(false);
            await resetAll().catch(() => undefined);
            refreshSnapshots();
          }}
        />
      ) : null}
      <ScrollTopButton />
    </section>
  );
}
