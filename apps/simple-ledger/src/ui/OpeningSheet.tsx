/*
 * 初期残高（kind='opening'）の専用シート。
 *  - OpeningRegisterSheet: 履歴の無い既存科目へ初期残高を登録する（勘定科目画面の「補正」導線が
 *    履歴ゼロのとき自動でこちらへ分岐。補正だと差分が収入/費用扱いになるため）。
 *    経路は createOpening 一本（新規科目つき opening・オンボーディングと同じ共通機能）。
 *  - OpeningEditSheet: 仕訳一覧の opening 行から金額・基準日を編集する。
 * 通常の仕訳編集で opening を壊さない（opening は開始時点の残高設定、補正とは会計的に別物）。
 */
import { useState } from 'react';
import { Modal } from './overlays';
import { TextInput } from '@snishi/foundation/ui/Field';
import { useLedger } from '../state/store';
import { parseSignedAmountText, sanitizeSignedAmountText } from './amountText';
import { todayLocal } from '../util/time';
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

/** 履歴の無い既存科目（資産・負債）へ初期残高を登録する（マイナス残高も可）。 */
export function OpeningRegisterSheet({
  account,
  onClose,
}: {
  account: Account;
  onClose: () => void;
}) {
  const { createOpening } = useLedger();
  const [amountText, setAmountText] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [submitting, setSubmitting] = useState(false);

  const amount = parseSignedAmountText(amountText);

  async function submit() {
    if (amount === null || amount === 0 || submitting) return;
    setSubmitting(true);
    try {
      await createOpening({ accountId: account.id, amount, date });
      onClose();
    } catch {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('opening.registerTitle', { name: account.name })}
      onClose={onClose}
      dismissMode="if-clean"
      dataUi={UI.adjustments.openingRegisterDialog}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={submitting || amount === null || amount === 0}
            data-ui={UI.adjustments.openingRegisterSave}
          >
            {t('opening.registerSave')}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="field__hint">{t('opening.registerIntro')}</p>
        <div className="kv">
          <span className="muted">{t('opening.account')}</span>
          <span>{account.name}</span>
        </div>
        <TextInput
          label={t('opening.amount')}
          required
          value={amountText}
          onChange={(v) => setAmountText(sanitizeSignedAmountText(v))}
          hint={t('common.signedAmountHint')}
          dataUi={UI.adjustments.openingRegisterAmount}
        />
        <TextInput
          label={t('opening.date')}
          type="date"
          value={date}
          onChange={setDate}
          dataUi={UI.adjustments.openingRegisterDate}
        />
      </div>
    </Modal>
  );
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

  // 表示は符号付き: 自然向き（資産=科目が借方 / 負債=科目が貸方）なら正、反転（マイナス残高）なら負。
  const targetLine = tgt ? entry.lines.find((l) => l.accountId === tgt.account.id) : undefined;
  const naturalSide = tgt?.account.type === 'asset' ? 'debit' : 'credit';
  const signedInitial =
    tgt === null ? '' : String(targetLine?.side === naturalSide ? tgt.amount : -tgt.amount);

  const [amountText, setAmountText] = useState(signedInitial);
  const [date, setDate] = useState(entry.date);
  const [submitting, setSubmitting] = useState(false);
  const amount = parseSignedAmountText(amountText);

  async function submit() {
    if (amount === null || amount === 0) return;
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
          value={amountText}
          onChange={(v) => setAmountText(sanitizeSignedAmountText(v))}
          hint={t('common.signedAmountHint')}
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
