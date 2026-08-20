/*
 * 按分できなかった補正 pin（完全整合性を欠く破損データ・v13.8 監査 H）の復旧表示。
 * stored のまま集計へ戻すのは**復旧処理**なので、黙って通常表示に混ぜず事実を名乗る:
 * 「この補正は按分できず、記録どおりの仕訳のまま集計している」。
 * 診断は表示専用であり、保存判断へは合流させない（打ち切り通知と同じ位置づけ）。
 */
import type { JournalEntry } from '../../domain/types';
import { t } from '../../i18n';

export function AdjustmentUnspreadNotice({
  unspread,
  dataUi,
}: {
  unspread: readonly JournalEntry[];
  dataUi?: string;
}) {
  return (
    <>
      {unspread.map((pin) => (
        <p
          className="field__hint"
          role="note"
          key={pin.id}
          {...(dataUi === undefined ? {} : { 'data-ui': dataUi })}
        >
          {t('adjust.unspreadNotice', { description: pin.description, date: pin.date })}
        </p>
      ))}
    </>
  );
}
