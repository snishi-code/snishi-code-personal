/*
 * ヘッダー + が開く「入力の種類」シート。収入/支出/振替の 3 種から選ぶ。
 * Dashboard の 3 ボタンと同じ入口（同じ EntrySheet の create を開く）。
 */
import { Modal } from '../Modal';
import { Icon, type IconName } from '../Icon';
import type { FormMode } from '../entryModes';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { UI } from '../../ui-contract';

const TYPES: {
  mode: Exclude<FormMode, 'manual'>;
  labelKey: MessageKey;
  icon: IconName;
  ui: string;
}[] = [
  { mode: 'income', labelKey: 'entry.type.income', icon: 'income', ui: UI.entryType.income },
  { mode: 'expense', labelKey: 'entry.type.expense', icon: 'expense', ui: UI.entryType.expense },
  {
    mode: 'transfer',
    labelKey: 'entry.type.transfer',
    icon: 'transfer',
    ui: UI.entryType.transfer,
  },
];

export function EntryTypeSheet({
  onPick,
  onClose,
}: {
  onPick: (mode: FormMode) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={t('entry.typePickTitle')}
      onClose={onClose}
      variant="dialog"
      dataUi={UI.entryType.sheet}
    >
      <div className="entry-types">
        {TYPES.map((ty) => (
          <button
            key={ty.mode}
            type="button"
            className="entry-type-btn"
            onClick={() => onPick(ty.mode)}
            data-ui={ty.ui}
          >
            <span className="entry-type-btn__icon">
              <Icon name={ty.icon} size={20} />
            </span>
            {t(ty.labelKey)}
          </button>
        ))}
      </div>
    </Modal>
  );
}
