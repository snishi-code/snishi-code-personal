// アプリの根 (最小 shell)。コピー移植した回診 UI (HomeView / DetailView / SettingsView) を
// createRoundsRuntime の上で描画する (コピー元: hospital-workspace の shell + RoundsSurface)。
//   - ヘッダー: 中央 = place 名 (タップで WsPicker) / 右 = 設定。
//   - 履歴: useAppHistory を 1 つだけ所有し、registries (overlay/編集) を配線する。
//   - view 切替は home / detail / settings の状態機械。

import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '@snishi/foundation/ui/AppHeader';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { useToast } from '@snishi/foundation/ui/toast';
import { useAppHistory } from '@snishi/foundation/history/useAppHistory';
import { createRoundsRuntime, useRevision, type AppRuntime } from './ui/appRuntime';
import { closeTopOverlay, exitTopEditing, isEditingActive } from './ui/registries';
import { HomeView } from './ui/HomeView';
import { DetailView } from './ui/DetailView';
import { SettingsView } from './ui/settings/SettingsView';
import { WsPicker } from './ui/pickers/WsPicker';
import { s } from './i18n';

type Page = 'home' | 'detail' | 'settings';

export function App() {
  const toast = useToast();
  // runtime は 1 回だけ生成・以後安定 (useState の lazy initializer)。
  const [runtime] = useState<AppRuntime>(() => createRoundsRuntime());
  useRevision(runtime);

  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [exitConfirm, setExitConfirm] = useState(false);
  const [wsPickerOpen, setWsPickerOpen] = useState(false);
  const [selectedNo, setSelectedNo] = useState(1);

  const { view, navigate, beginExit } = useAppHistory({
    initialView: 'home',
    closeTopOverlay,
    isEditing: isEditingActive,
    exitEdit: exitTopEditing,
    isExitConfirmOpen: () => exitConfirm,
    showExitConfirm: () => setExitConfirm(true),
  });
  const page = view as Page;

  // 起動 (initStore) + スナップショット DB の起動時整備 (TTL 失効分の物理削除。best-effort)。
  useEffect(() => {
    let alive = true;
    runtime.store
      .initStore()
      .then(() => {
        if (alive) setBooted(true);
        void runtime.snapshots.init();
        runtime.store.requestStoragePersistence();
      })
      .catch((e: unknown) => {
        if (alive) setBootError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [runtime]);

  // タブ非表示/終了直前に debounce 中の保存を確定する (unload 経路ではエラー通知できないため握る)。
  useEffect(() => {
    const flush = () => {
      try {
        runtime.store.flushSavePending();
      } catch {
        /* unload 経路では通知できない */
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [runtime]);

  // 保存失敗 (fire-and-forget) の可視化。
  useEffect(() => {
    runtime.setSaveErrorHandler(() => toast.show(s.save.failed, 'error'));
    return () => runtime.setSaveErrorHandler(null);
  }, [runtime, toast]);

  const openPatient = useCallback(
    (no: number) => {
      setSelectedNo(no);
      window.scrollTo(0, 0);
      navigate('detail');
    },
    [navigate],
  );

  if (bootError) {
    return (
      <div className="appBoot">
        <p className="dangerText">{s.boot.initFailed(bootError)}</p>
      </div>
    );
  }

  // ヘッダー中央 = 現在の place 名 (アーカイブビュー中はそのラベル)。タップで place picker。
  const placeName = runtime.store.isArchiveViewActive()
    ? s.shell.archiveViewLabel
    : runtime.store.getActivePlace()?.name;

  return (
    <>
      <AppHeader
        dataUi="shell.header"
        center={
          <div className="headerTitleRow">
            <button type="button" className="headerTitleBtn" onClick={() => setWsPickerOpen(true)}>
              {placeName || s.shell.wardFallback}
              <Icon name="expand" size={14} />
            </button>
          </div>
        }
        right={
          <IconButton label={s.shell.settingsLabel} onClick={() => navigate('settings')}>
            <Icon name="settings" size={18} />
          </IconButton>
        }
      />

      <main className="appMain">
        {!booted ? (
          <p className="muted appBoot">{s.boot.loading}</p>
        ) : page === 'settings' ? (
          <SettingsView runtime={runtime} onNavigateHome={() => navigate('home')} />
        ) : page === 'detail' ? (
          <DetailView
            runtime={runtime}
            selectedNo={selectedNo}
            onNavigateHome={() => navigate('home')}
          />
        ) : (
          <HomeView runtime={runtime} onOpenPatient={openPatient} />
        )}
      </main>

      {wsPickerOpen ? <WsPicker runtime={runtime} onClose={() => setWsPickerOpen(false)} /> : null}

      {exitConfirm ? (
        <ConfirmDialog
          title={s.shell.exit.title}
          body={s.shell.exit.body}
          confirmLabel={s.shell.exit.confirm}
          onConfirm={() => {
            setExitConfirm(false);
            beginExit();
          }}
          onCancel={() => setExitConfirm(false)}
          dataUi="shell.exitConfirm"
        />
      ) : null}
    </>
  );
}
