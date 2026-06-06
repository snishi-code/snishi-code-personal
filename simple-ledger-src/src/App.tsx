/*
 * アプリ本体。ヘッダー + 画面切替 + メニュー + 仕訳シート + 更新バナー。
 * ルーティングは MVP では state ベースの単純な画面切替。
 */
import { useState } from 'react';
import { useLedger } from './state/store';
import { Header } from './ui/Header';
import { Menu } from './ui/Menu';
import { Dashboard } from './ui/screens/Dashboard';
import { Journal } from './ui/screens/Journal';
import { Statements } from './ui/screens/Statements';
import { Accounts } from './ui/screens/Accounts';
import { Settings } from './ui/screens/Settings';
import { Help } from './ui/screens/Help';
import { EntrySheet } from './ui/screens/EntrySheet';
import { useServiceWorker } from './pwa/useServiceWorker';
import { Icon } from './ui/Icon';
import { t } from './i18n';
import type { Screen } from './ui/navigation';
import type { JournalEntry } from './domain/types';

export function App() {
  const { status, ledger, error } = useLedger();
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // entrySheet: false=閉, true=新規, JournalEntry=編集
  const [entrySheet, setEntrySheet] = useState<JournalEntry | true | null>(null);
  const { updateReady, applyUpdate } = useServiceWorker();

  if (status === 'loading') {
    return (
      <main className="app-main center" aria-busy="true">
        <p className="muted">{t('common.loading')}</p>
      </main>
    );
  }

  if (status === 'error' || !ledger) {
    return (
      <main className="app-main">
        <div className="banner" role="alert">
          <Icon name="alert" size={18} />
          {error ?? t('toast.error')}
        </div>
      </main>
    );
  }

  const openCreate = () => setEntrySheet(true);
  const openEdit = (entry: JournalEntry) => setEntrySheet(entry);

  return (
    <>
      <a className="skip-link" href="#main">
        {t('common.home')}
      </a>
      <Header
        ledgerName={ledger.settings.ledgerName}
        onHome={() => setScreen('dashboard')}
        onAddEntry={openCreate}
        onMenu={() => setMenuOpen(true)}
      />

      <main className="app-main" id="main">
        {updateReady ? (
          <div className="banner" role="status">
            <Icon name="alert" size={18} />
            {t('update.available')}
            <button type="button" className="btn btn--primary" onClick={applyUpdate}>
              {t('update.apply')}
            </button>
          </div>
        ) : null}

        {screen === 'dashboard' ? (
          <Dashboard onAddEntry={openCreate} onEditEntry={openEdit} onNavigate={setScreen} />
        ) : null}
        {screen === 'journal' ? <Journal onEditEntry={openEdit} /> : null}
        {screen === 'statements' ? <Statements /> : null}
        {screen === 'accounts' ? <Accounts /> : null}
        {screen === 'settings' ? <Settings /> : null}
      </main>

      {menuOpen ? (
        <Menu
          current={screen}
          onNavigate={setScreen}
          onClose={() => setMenuOpen(false)}
          onHelp={() => setHelpOpen(true)}
        />
      ) : null}

      {entrySheet ? (
        <EntrySheet
          existing={entrySheet === true ? undefined : entrySheet}
          onClose={() => setEntrySheet(null)}
        />
      ) : null}

      {helpOpen ? <Help onClose={() => setHelpOpen(false)} /> : null}
    </>
  );
}
