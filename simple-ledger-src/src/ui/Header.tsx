/*
 * ヘッダー: 左=ホーム / 中央=台帳名・年月 / 右=≡(メニュー)。
 * 入力導線はホームの 収入/支出/振替 ボタンに集約し、ヘッダーには + を置かない。
 */
import { Icon } from './Icon';
import { t } from '../i18n';
import { UI } from '../ui-contract';
import { currentYearMonth } from '../util/time';

export function Header({
  ledgerName,
  onHome,
  onMenu,
}: {
  ledgerName: string;
  onHome: () => void;
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
          <span className="app-header__name">{t('header.yearMonth', { year, month })}</span>
          <span className="app-header__sub">{ledgerName}</span>
        </div>
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
