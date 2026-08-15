/*
 * 復旧導線。台帳が読めない / 画面が描画時に落ちたときでも「設定」（JSON 読み込み・
 * スナップショット復元・全データ削除）へ必ず到達できるようにする。
 *
 * これが無いと、DB のバージョン更新に失敗した端末は banner 1 枚で詰む
 * （旧ビルドへ戻しても IndexedDB は VersionError になる）。
 */
import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog } from './overlays';
import { Settings } from './screens/Settings';
import { wipeDatabase } from '../data/db';
import { errorText, t } from '../i18n';
import { UI } from '../ui-contract';

/**
 * エラー表示 + 「設定」（JSON 読み込み・復元）と「DB を初期化して再起動」の最小画面。
 * 後者は IndexedDB の版が新しくて開けない（VersionError）等、設定にすら入れない詰みからの
 * 最終復旧手段（deleteDatabase → reload）。文言は既存キーを使い回す。
 */
export function RecoveryScreen({
  message,
  schemaMismatch,
}: {
  message?: string;
  /** 保存データが旧版（meta.schemaVersion 不一致）。直接 import は内部の loadLedger も
   *  同じ版不一致で失敗して通らないため、設定への導線を出さず正式手順を明示する。 */
  schemaMismatch?: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState(false);
  const [wipeError, setWipeError] = useState(false);
  return (
    <main className="app-main" id="main" data-ui={UI.app.recovery}>
      <div className="banner" role="alert">
        <Icon name="alert" size={18} />
        {message ?? t('toast.error')}
      </div>
      {wipeError ? (
        <div className="banner" role="alert">
          <Icon name="alert" size={18} />
          {t('recovery.wipeFailed')}
        </div>
      ) : null}
      {schemaMismatch ? (
        // 正式な移行手順（旧版 JSON → 単発変換 → 初期化 → 現行版 JSON を読み込み）。
        <p className="field__hint">{t('recovery.schemaMismatchHint')}</p>
      ) : settingsOpen ? (
        // 復旧中は他画面へ遷移させない（台帳が無い状態で開けないため）。
        <Settings onOpenOnboarding={() => undefined} />
      ) : (
        <button
          type="button"
          className="btn btn--block"
          onClick={() => setSettingsOpen(true)}
          data-ui={UI.app.recoverySettings}
        >
          <Icon name="settings" size={18} />
          {t('nav.settings')}
        </button>
      )}
      <button
        type="button"
        className="btn btn--block"
        style={{ marginTop: 'var(--space-3)' }}
        onClick={() => setWipeConfirm(true)}
        data-ui={UI.app.recoveryWipe}
      >
        <Icon name="delete" size={18} />
        {t('recovery.wipe')}
      </button>
      {wipeConfirm ? (
        <ConfirmDialog
          title={t('reset.confirmTitle')}
          body={t('reset.confirmBody')}
          confirmLabel={t('recovery.wipe')}
          danger
          onCancel={() => setWipeConfirm(false)}
          onConfirm={async () => {
            // 成功（onsuccess）のときだけ reload する。error / blocked（別タブが接続を保持）は
            // この画面に留まり、原因と再試行の案内を出す（fail-closed・監査 P2-5）。
            try {
              await wipeDatabase();
              window.location.reload();
            } catch {
              setWipeConfirm(false);
              setWipeError(true);
            }
          }}
        />
      ) : null}
    </main>
  );
}

interface Props {
  children: ReactNode;
}

interface State {
  message?: string;
  failed: boolean;
}

/** 描画時例外を受け止めて RecoveryScreen へ落とす（アプリ全体を包む 1 つだけ）。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(error: unknown): State {
    // LedgerError の message は i18n キーそのもの（errors.ts が super(code) するため）。
    // 生のキーをバナーへ出さず、他の全経路（toast）と同じ errorText で文言化する。
    return { failed: true, message: error instanceof Error ? errorText(error) : undefined };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // 端末内のみ。外部へは送らない（no-exfil）。
    console.error('[simple-ledger] render error', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) return <RecoveryScreen message={this.state.message} />;
    return this.props.children;
  }
}
