/*
 * 初期残高（kind='opening'）の専用編集シート。仕訳一覧の opening 行から開く。
 * 登録は科目追加シート（AccountSheet）の初期残高欄で行い、この画面では金額・基準日だけを編集する。
 * 通常の仕訳編集で opening を壊さない（opening は開始時点の残高設定、補正とは会計的に別物）。
 */
import { useState } from 'react';
import { Modal } from '@snishi/foundation/ui/Modal';
import { TextInput } from '@snishi/foundation/ui/Field';
import { useLedger } from '../state/store';
import type { Account, JournalEntry } from '../domain/types';
import { t } from '../i18n';
import { UI } from '../ui-contract';

/** opening 仕訳の対象（equity でない側）の科目と金額。 */
export function openingTarget(
  entry: JournalEntry,
  byId: Map<string, Account>,
): { account: Account; amount: number } | null {
  for (const l of entry.lines) {
    const a = byId.get(l.accountId);
    if (a && a.role !== 'equity') return { account: a, amount: l.amount };
  }
  return null;
}

export function OpeningEditSheet({
  entry,
  onClose,
}: {
  entry: JournalEntry;
  onClose: () => void;
}) {
  const { ledger, updateOpening } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const byId = new Map(accounts.map((a) => [a.id, a] as const));
  const tgt = openingTarget(entry, byId);

  const [amountText, setAmountText] = useState(String(tgt?.amount ?? ''));
  const [date, setDate] = useState(entry.date);
  const [submitting, setSubmitting] = useState(false);
  const amount = amountText === '' ? null : Number.parseInt(amountText.replace(/[^\d]/g, ''), 10);

  async function submit() {
    if (amount === null || amount < 1) return;
    setSubmitting(true);
    try {
      await updateOpening({ id: entry.id, amount, date });
      onClose();
    } catch {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('opening.editTitle')}
      onClose={onClose}
      dismissMode="if-clean"
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={submitting}
            data-ui={UI.adjustments.openingEditSave}
          >
            {t('opening.update')}
          </button>
        </>
      }
    >
      <div className="stack" data-ui={UI.adjustments.openingEditDialog}>
        <div className="kv">
          <span className="muted">{t('opening.account')}</span>
          <span>{tgt?.account.name ?? '—'}</span>
        </div>
        <TextInput
          label={t('opening.amount')}
          required
          inputMode="numeric"
          value={amountText}
          onChange={(v) => setAmountText(v.replace(/[^\d]/g, ''))}
          dataUi={UI.adjustments.openingEditAmount}
        />
        <TextInput
          label={t('opening.date')}
          type="date"
          value={date}
          onChange={setDate}
          dataUi={UI.adjustments.openingEditDate}
        />
      </div>
    </Modal>
  );
}
