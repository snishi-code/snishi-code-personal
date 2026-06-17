/*
 * 汎用ナビメニューシェル(中央モーダル)。項目はアプリが items で注入する
 * (ナビ先・アイコン・現在位置の判断はアプリ側の知識。ここは器だけ)。
 * 背景タップ・Escape で閉じ、項目選択後も閉じる。
 */
import { Modal } from './Modal';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export interface MenuItem {
  key: string;
  label: string;
  icon?: IconName;
  /** 現在表示中の画面なら true(aria-current="page")。 */
  current?: boolean;
  onSelect: () => void;
  dataUi?: string;
}

export function Menu({
  items,
  onClose,
  title = 'メニュー',
  dataUi,
}: {
  items: MenuItem[];
  onClose: () => void;
  title?: string;
  dataUi?: string;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      dismissMode="always"
      variant="dialog"
      titleVariant="sr-only"
      dataUi={dataUi}
    >
      <nav className="menu-list" aria-label={title}>
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            className="menu-item"
            aria-current={item.current ? 'page' : undefined}
            data-ui={item.dataUi}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.icon ? <Icon name={item.icon} size={18} /> : null}
            {item.label}
          </button>
        ))}
      </nav>
    </Modal>
  );
}
