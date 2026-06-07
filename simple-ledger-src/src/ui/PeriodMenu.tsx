/*
 * 期間選択モーダル。ヘッダー中央の期間ボタンから開く。
 * 中身は PeriodSwitcher（年を選ぶ/全期間 → 月/年全体）。
 * 既存 Modal の dialog variant を土台にする（モバイル=下部シート / デスクトップ=中央パネル、
 * 背景タップ・Escape で閉じる）。期間変更は即時反映され、「完了」で閉じる。
 */
import { Modal } from './Modal';
import { PeriodSwitcher } from './PeriodSwitcher';
import { t } from '../i18n';
import type { ReportPeriod } from '../domain/reportPeriod';

export function PeriodMenu({
  value,
  onChange,
  onClose,
  today,
  years,
}: {
  value: ReportPeriod;
  onChange: (p: ReportPeriod) => void;
  onClose: () => void;
  today: string;
  years: number[];
}) {
  return (
    <Modal
      title={t('period.title')}
      onClose={onClose}
      dismissMode="always"
      variant="dialog"
      titleVariant="sr-only"
      footer={
        <button type="button" className="btn btn--primary" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <PeriodSwitcher value={value} onChange={onChange} today={today} years={years} />
    </Modal>
  );
}
