/*
 * 設定。JSON export/import、スナップショット、全データ削除、アプリ情報、台帳設定。
 * 破壊的操作(全削除/復元)は明示確認・背景タップ無効・fail-closed。
 *
 * v13.9 項目 1（監査 #6 の根本対応・作者決定 2026-08-20）:
 *  - 強制 import（revision 競合を force で上書きして既存台帳を置換する取り込み）は機能ごと撤去。
 *  - 取り込みは**空の台帳（取引データなし）のときだけ**有効（durable 境界 = exportImport も同判定）。
 *  - 全削除は「最終変更よりも新しい JSON エクスポートが実行済み」のときだけ実行できる
 *    （確認ダイアログにエクスポートを同居・未実施なら削除ボタン disabled + 理由表示）。
 *
 * v2 変更点:
 *  - revision-conflict: importRevision（v1 の baseRevision を廃止）
 *  - unsupported-version: reason enum 廃止 → outcome.detail を直接表示
 *  - useToast: @snishi/foundation/ui/toast
 *  - Icon/ConfirmDialog/TextInput: @snishi/foundation/ui/*
 */
import { startTransition, useEffect, useReducer, useRef, useState } from 'react';
import { useToast } from '@snishi/foundation/ui/toast';
import { ConfirmDialog, Modal } from '../overlays';
import { TextInput } from '@snishi/foundation/ui/Field';
import { Segmented } from '@snishi/foundation/ui/Segmented';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../../state/store';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import { APP_ID } from '../../domain/constants';
import { isImportableEmptyLedger, type ImportOutcome } from '../../data/exportImport';
import { isExportedLedgerVersionCurrent } from '../../data/localFlags';
import type { Ledger, Settings as LedgerSettings, Snapshot } from '../../domain/types';
import { ScrollTopButton } from '../ScrollTopButton';

const APP_VERSION = '0.1.0';

export function importErrorMessage(outcome: Exclude<ImportOutcome, { kind: 'ok' }>): string {
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
        outcome.detail === 'error.common.revisionExhausted' ||
        outcome.detail === 'error.import.requiresEmpty'
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
  onOpenOnboarding,
}: {
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
  const [pendingRestore, setPendingRestore] = useState<Snapshot | null>(null);
  const [pendingDeleteSnap, setPendingDeleteSnap] = useState<Snapshot | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const [ledgerName, setLedgerName] = useState(ledger?.settings.ledgerName ?? '');
  const [currency, setCurrency] = useState(ledger?.settings.currency ?? '');
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

  async function runImport(text: string) {
    const outcome = await importJson(text);
    if (outcome.kind === 'ok') {
      refreshSnapshots();
      return;
    }
    toast.show(importErrorMessage(outcome), 'error');
  }

  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      toast.show(t('import.error.parse'), 'error');
      return;
    }
    // importJson の例外（置換後の再読込失敗など）は store が toast 済み。二重通知しない。
    await runImport(text).catch(() => undefined);
  }

  // 取り込みは空の台帳（取引データなし）のときだけ（v13.9 項目 1）。台帳が読めない
  // 復旧経路（ledger = null）は取り込み自体が復旧手段なので出す。判定の正本は
  // exportImport（durable 境界でも同じ関数で拒否される）。
  const canImport = !ledger || isImportableEmptyLedger(ledger);

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
            disabled={!canImport}
            onClick={() => fileRef.current?.click()}
            data-ui={UI.settings.importJson}
          >
            <Icon name="upload" size={18} />
            {t('settings.import')}
          </button>
          {!canImport ? (
            <p
              className="field__hint"
              role="note"
              style={{ marginTop: 6 }}
              data-ui={UI.settings.importEmptyOnlyNote}
            >
              {t('settings.importEmptyOnly')}
            </p>
          ) : null}
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
        {/* 「資金繰りの既定表示期間」は v13.4 ③ で撤去（資金繰りは基準日起点の横スクロールで
            範囲を決めるため、既定期間という設定そのものが無くなった）。 */}
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
      {pendingRestore ? (
        <ConfirmDialog
          title={t('snapshot.restoreConfirmTitle')}
          body={t('snapshot.restoreConfirmBody')}
          confirmLabel={t('snapshot.restore')}
          onCancel={() => setPendingRestore(null)}
          onConfirm={async () => {
            try {
              await restoreSnapshot(pendingRestore);
            } catch {
              // 失敗 = 未保存: 閉じない（エラーは store が toast 済み・確定中状態は ConfirmDialog が解く）。
              return;
            }
            setPendingRestore(null);
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
            try {
              await deleteSnapshot(pendingDeleteSnap.id);
            } catch {
              // 失敗 = 未保存: 閉じない（エラーは store が toast 済み・確定中状態は ConfirmDialog が解く）。
              return;
            }
            setPendingDeleteSnap(null);
            refreshSnapshots();
          }}
        />
      ) : null}

      {confirmReset ? (
        <ResetConfirmDialog
          ledger={ledger}
          onExport={exportJson}
          onCancel={() => setConfirmReset(false)}
          onConfirm={async () => {
            try {
              await resetAll();
            } catch {
              // 失敗 = 未保存: 閉じない（エラーは store が toast 済み）。
              return;
            }
            setConfirmReset(false);
            refreshSnapshots();
          }}
        />
      ) : null}
      <ScrollTopButton />
    </section>
  );
}

/**
 * 全削除の確認ダイアログ（v13.9 項目 1・作者決定）。
 *
 * ConfirmDialog を使わない専用面: 「JSON をエクスポート」を同居させ、**最終変更よりも新しい
 * エクスポートが実行済みのときだけ**削除を実行できる。判定は localFlags に記録した
 * 「最後に書き出した台帳世代（deviceId + revision）」と現在の台帳世代の一致
 * （端末ローカルでよい・作者決定）。台帳が読めない復旧経路（ledger = null）は
 * エクスポート自体が不可能なので、このゲートは課さない（復旧を詰ませない）。
 */
function ResetConfirmDialog({
  ledger,
  onExport,
  onCancel,
  onConfirm,
}: {
  ledger: Ledger | null;
  /** JSON エクスポート（成功時に台帳世代が localFlags へ記録される）。 */
  onExport: () => void;
  onCancel: () => void;
  /** 実削除。失敗時は呼び出し側が toast 済みで、ダイアログは開いたまま。 */
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  // localFlags は非リアクティブなので、エクスポート実行後に判定を引き直すための tick。
  const [, bumpExportTick] = useReducer((count: number) => count + 1, 0);
  const keyword = t('reset.keyword');
  const keywordOk = typed.trim() === keyword;
  const exportCurrent = ledger === null || isExportedLedgerVersionCurrent(ledger.meta);

  function runExport(): void {
    try {
      onExport();
    } catch {
      // エラーは store が toast 済み。記録されていないので判定は変わらない。
      return;
    } finally {
      bumpExportTick();
    }
  }

  async function confirm(): Promise<void> {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('reset.confirmTitle')}
      onClose={busy ? () => undefined : onCancel}
      dismissMode="never"
      dataUi={UI.settings.resetConfirm}
      footer={
        <>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={onCancel}
            data-ui={UI.dialog.cancel}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy || !keywordOk || !exportCurrent}
            onClick={confirm}
            data-ui={UI.settings.resetConfirmDelete}
          >
            {t('settings.resetAll')}
          </button>
        </>
      }
    >
      <div className="stack">
        <p>{t('reset.confirmBody')}</p>
        {/* エクスポートを同居させる: 削除の前に必ず「いま」の台帳を書き出せる。 */}
        <button
          type="button"
          className="btn btn--block"
          disabled={busy}
          onClick={runExport}
          data-ui={UI.settings.resetConfirmExport}
        >
          <Icon name="download" size={18} />
          {t('settings.export')}
        </button>
        {exportCurrent ? (
          <p className="field__hint">{t('reset.exportDone')}</p>
        ) : (
          // エクスポート未実施なら削除は disabled + 理由を明示する（fail-closed）。
          <p
            className="field__hint"
            role="note"
            data-ui={UI.settings.resetConfirmExportRequired}
          >
            {t('reset.exportRequired')}
          </p>
        )}
        <div className="field">
          <label className="field__label" htmlFor="reset-confirm-keyword">
            {t('reset.keywordPrompt', { keyword })}
          </label>
          <input
            id="reset-confirm-keyword"
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>
    </Modal>
  );
}
