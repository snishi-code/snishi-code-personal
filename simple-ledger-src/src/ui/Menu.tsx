/*
 * メニュー（中央モーダル / モバイルは下部シート）。一時的な操作パネルとして開く。
 * 右ドロワー（.drawer）はやめ、共通の Modal（dialog variant）を土台にする。
 * 背景タップ・Escape で閉じ、メニュー内クリックでは閉じない（Modal が担保）。
 * 項目: 月額化コスト / 資金計画・負債 / 設定 / ヘルプ。
 */
import { Modal } from './Modal';
import { Icon } from './Icon';
import { NAV_ITEMS, type Screen } from './navigation';
import { t } from '../i18n';
import { UI } from '../ui-contract';

export function Menu({
  current,
  onNavigate,
  onClose,
  onHelp,
}: {
  current: Screen;
  onNavigate: (screen: Screen) => void;
  onClose: () => void;
  onHelp: () => void;
}) {
  return (
    <Modal title={t('common.menu')} onClose={onClose} dismissMode="always" variant="dialog">
      <nav className="menu-list" aria-label={t('common.menu')} data-ui={UI.nav.menu}>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.screen}
            type="button"
            className="menu-item"
            aria-current={current === item.screen ? 'page' : undefined}
            onClick={() => {
              onNavigate(item.screen);
              onClose();
            }}
            data-ui={`nav.${item.screen}`}
          >
            <Icon name={item.icon} size={18} />
            {t(item.labelKey)}
          </button>
        ))}
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            onHelp();
            onClose();
          }}
        >
          <Icon name="help" size={18} />
          {t('nav.help')}
        </button>
      </nav>
    </Modal>
  );
}
