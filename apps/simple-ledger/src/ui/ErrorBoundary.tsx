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
import { t } from '../i18n';
import { UI } from '../ui-contract';

/**
 * エラー表示 + 「設定」（JSON 読み込み・復元）と「DB を初期化して再起動」の最小画面。
 * 後者は IndexedDB の版が新しくて開けない（VersionError）等、設定にすら入れない詰みからの
 * 最終復旧手段（deleteDatabase → reload）。文言は既存キーを使い回す。
 */
export function RecoveryScreen({ message }: { message?: string }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState(false);
  return (
    <main className="app-main" id="main" data-ui={UI.app.recovery}>
      <div className="banner" role="alert">
        <Icon name="alert" size={18} />
        {message ?? t('toast.error')}
      </div>
      {settingsOpen ? (
        // 復旧中は他画面へ遷移させない（台帳が無い状態で開けないため）。
        <Settings onNavigate={() => undefined} onOpenOnboarding={() => undefined} />
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
            await wipeDatabase();
            window.location.reload();
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
    return { failed: true, message: error instanceof Error ? error.message : undefined };
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
