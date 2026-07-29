/*
 * 画面遷移の根。ルータは使わず view の状態機械 1 つで持つ
 * （home → detail / settings / archive の 1 階層。深いスタックを作らない）。
 */
import { useEffect, useState } from 'react';
import { initStore } from './data/store';
import { t } from './i18n';
import { ArchiveView } from './ui/ArchiveView';
import { DetailView } from './ui/DetailView';
import { HomeView } from './ui/HomeView';
import { SettingsView } from './ui/SettingsView';
import { useStore } from './ui/useStore';

type View =
  | { name: 'home' }
  | { name: 'detail'; subjectId: string }
  | { name: 'settings' }
  | { name: 'archive' };

export function App() {
  const { ready } = useStore();
  const [view, setView] = useState<View>({ name: 'home' });
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    initStore().catch((e: unknown) => {
      setInitError(e instanceof Error ? e.message : String(e));
    });
  }, []);

  if (initError) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: '1.1rem' }}>起動に失敗しました</h1>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.8rem' }}>{initError}</pre>
      </div>
    );
  }
  if (!ready) {
    return <div style={{ padding: 24, color: '#64748b' }}>{t('common.loading')}</div>;
  }

  const goHome = () => setView({ name: 'home' });

  switch (view.name) {
    case 'detail':
      return (
        <DetailView
          subjectId={view.subjectId}
          onBack={goHome}
        />
      );
    case 'settings':
      return <SettingsView onBack={goHome} />;
    case 'archive':
      return <ArchiveView onBack={goHome} />;
    default:
      return (
        <HomeView
          onOpenSubject={(subjectId: string) => setView({ name: 'detail', subjectId })}
          onOpenSettings={() => setView({ name: 'settings' })}
          onOpenArchive={() => setView({ name: 'archive' })}
        />
      );
  }
}
