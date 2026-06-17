import { Modal } from '@snishi/foundation/ui/Modal';
import { t } from '../../i18n';

export function Help({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={t('help.title')} onClose={onClose}>
      <p>{t('help.body')}</p>
    </Modal>
  );
}
