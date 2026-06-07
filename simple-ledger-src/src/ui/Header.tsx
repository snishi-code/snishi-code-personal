/*
 * ヘッダー: 左=ホーム / 中央=期間ボタン（押すと期間メニュー）/ 右=≡(メニュー)。
 * 中央は選択中の期間ラベル（2026年6月 / 2026年 / 全期間）を表示する。
 * 入力導線はホームの 収入/支出/振替 に集約し、ヘッダーに + は置かない。
 * 台帳名はヘッダーに出さない（設定で編集・export 名に使う）。
 */
import { Icon } from './Icon';
import { t } from '../i18n';
import { UI } from '../ui-contract';
import { periodLabel, type ReportPeriod } from '../domain/reportPeriod';

export function Header({
  period,
  onHome,
  onOpenPeriod,
  onMenu,
}: {
  period: ReportPeriod;
  onHome: () => void;
  onOpenPeriod: () => void;
  onMenu: () => void;
}) {
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
        <button
          type="button"
          className="app-header__period"
          onClick={onOpenPeriod}
          aria-haspopup="dialog"
          aria-label={`${periodLabel(period)} — ${t('period.open')}`}
          data-ui={UI.period.button}
        >
          <span className="app-header__period-text">
            <span className="app-header__name">{periodLabel(period)}</span>
          </span>
          <Icon name="chevronDown" size={14} />
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
