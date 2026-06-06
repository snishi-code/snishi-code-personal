/*
 * ヘッダー: 左=ホーム / 中央=台帳名・年月 / 右=+(仕訳追加)・≡(メニュー)。
 * + は MVP 最重要操作なのでメニューに埋めず常に表に出す。
 */
import { Icon } from './Icon';
import { t } from '../i18n';
import { UI } from '../ui-contract';
import { currentYearMonth } from '../util/time';

export function Header({
  ledgerName,
  onHome,
  onAddEntry,
  onMenu,
}: {
  ledgerName: string;
  onHome: () => void;
  onAddEntry: () => void;
  onMenu: () => void;
}) {
  const { year, month } = currentYearMonth();
  return (
    <header className="app-header">
      <div className="app-header__inner">
        <button
          type="button"
          className="icon-btn"
          onClick={onHome}
          aria-label={t('header.home')}
          data-ui={UI.nav.home}
        >
          <Icon name="home" />
        </button>
        <div className="app-header__title">
          <span className="app-header__name">{ledgerName}</span>
          <span className="app-header__sub">{t('dashboard.thisMonth', { year, month })}</span>
        </div>
        <button
          type="button"
          className="icon-btn icon-btn--primary"
          onClick={onAddEntry}
          aria-label={t('header.addEntry')}
          data-ui={UI.journal.create}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={onMenu}
          aria-label={t('a11y.openMenu')}
          aria-haspopup="menu"
          data-ui={UI.nav.menuButton}
        >
          <Icon name="menu" />
        </button>
      </div>
    </header>
  );
}
