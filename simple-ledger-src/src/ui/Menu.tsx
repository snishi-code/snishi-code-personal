/*
 * メニュー（右からのドロワー）。Dashboard / Journal / Statements / Accounts / Settings / Help。
 * 補助操作はここに集約し、主要操作(+)はヘッダーに残す。
 */
import { useEffect, useRef } from 'react';
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('common.menu')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="drawer__header">
          <span className="drawer__title">{t('common.menu')}</span>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label={t('a11y.closeMenu')}
          >
            <Icon name="close" />
          </button>
        </div>
        <nav aria-label={t('common.menu')} data-ui={UI.nav.menu}>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.screen}
              type="button"
              className="drawer__link"
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
            className="drawer__link"
            onClick={() => {
              onHelp();
              onClose();
            }}
          >
            <Icon name="help" size={18} />
            {t('nav.help')}
          </button>
        </nav>
      </div>
    </div>
  );
}
