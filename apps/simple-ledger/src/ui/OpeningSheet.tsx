/*
 * 初期残高（kind='opening'）の専用シート。
 *  - OpeningRegisterSheet: 履歴の無い既存科目へ初期残高を登録する（勘定科目画面の「補正」導線が
 *    履歴ゼロのとき自動でこちらへ分岐。補正だと差分が収入/費用扱いになるため）。
 *    経路は createOpening 一本（新規科目つき opening・オンボーディングと同じ共通機能）。
 *  - OpeningEditSheet: 仕訳一覧の opening 行から金額・基準日を編集する。
 * 通常の仕訳編集で opening を壊さない（opening は開始時点の残高設定、補正とは会計的に別物）。
 */
import { useState } from 'react';
import { ConfirmDialog, Modal } from './overlays';
import { TextInput } from '@snishi/foundation/ui/Field';
import { useLedger } from '../state/store';
import { formatMinorForInput, parseAmountToMinor, sanitizeSignedAmountText } from './amountText';
import { useMoneyDigits } from './money';
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
  const digits = useMoneyDigits();
  const [amountText, setAmountText] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [submitting, setSubmitting] = useState(false);

  const amount = parseAmountToMinor(amountText);

  async function submit() {
    if (amount === null || amount === 0 || date.trim() === '' || submitting) return;
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
            disabled={submitting || amount === null || amount === 0 || date.trim() === ''}
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
          // 符号付きの欄は inputMode を指定しない: numeric / decimal のソフトキーボードには
          // '-' キーが無く、hint（マイナスは先頭に -）どおりの入力ができなくなる。
          // 「表示桁が inputMode を決める」規約の明示的な例外（AccountSheet の想定利回り欄と同じ趣旨）。
          onChange={(v) => setAmountText(sanitizeSignedAmountText(v, digits, amountText))}
          hint={t('common.signedAmountHint')}
          dataUi={UI.adjustments.openingRegisterAmount}
        />
        <TextInput
          label={t('opening.date')}
          required
          type="date"
          value={date}
          onChange={setDate}
          dataUi={UI.adjustments.openingRegisterDate}
        />
      </div>
    </Modal>
  );
}

export function OpeningEditSheet({ entry, onClose }: { entry: JournalEntry; onClose: () => void }) {
  const { ledger, updateOpening, deleteOpening } = useLedger();
  // 破壊的操作は編集シート最下部（動詞体系 v13.1）。行アクションには置かない。
  const [pendingDelete, setPendingDelete] = useState(false);
  const accounts = ledger?.accounts ?? [];
  const byId = new Map(accounts.map((a) => [a.id, a] as const));
  const tgt = openingTarget(entry, byId);

  // 表示は符号付き: 自然向き（資産=科目が借方 / 負債=科目が貸方）なら正、反転（マイナス残高）なら負。
  const targetLine = tgt ? entry.lines.find((l) => l.accountId === tgt.account.id) : undefined;
  const naturalSide = tgt?.account.type === 'asset' ? 'debit' : 'credit';
  const digits = useMoneyDigits();
  const signedInitial =
    tgt === null
      ? ''
      : formatMinorForInput(targetLine?.side === naturalSide ? tgt.amount : -tgt.amount, digits);

  const [amountText, setAmountText] = useState(signedInitial);
  // 変更判定はフラグではなく値（初期表示と同じ文字列に戻れば無変更 = 保存済み minor を保持）。
  const amountDirty = amountText !== signedInitial;
  const [date, setDate] = useState(entry.date);
  const [submitting, setSubmitting] = useState(false);
  const originalAmount =
    targetLine?.side === naturalSide ? (tgt?.amount ?? 0) : -(tgt?.amount ?? 0);
  // 日付だけを直す保存では、表示桁で隠れた minor を保持する。
  const amount = amountDirty ? parseAmountToMinor(amountText) : originalAmount;

  async function submit() {
    if (amount === null || amount === 0 || date.trim() === '' || submitting) return;
    setSubmitting(true);
    try {
      await updateOpening({ id: entry.id, amount, date });
      onClose();
    } catch {
      setSubmitting(false);
    }
  }

  return (
    <>
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
              disabled={submitting || amount === null || amount === 0 || date.trim() === ''}
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
            // 符号付きの欄は inputMode を指定しない: numeric / decimal のソフトキーボードには
            // '-' キーが無く、hint（マイナスは先頭に -）どおりの入力ができなくなる。
            // 「表示桁が inputMode を決める」規約の明示的な例外（AccountSheet の想定利回り欄と同じ趣旨）。
            onChange={(v) => {
              setAmountText(sanitizeSignedAmountText(v, digits, amountText));
            }}
            hint={t('common.signedAmountHint')}
            dataUi={UI.adjustments.openingEditAmount}
          />
          <TextInput
            label={t('opening.date')}
            required
            type="date"
            value={date}
            onChange={setDate}
            dataUi={UI.adjustments.openingEditDate}
          />
          {/* 破壊的なほど下（動詞体系 v13.1）。行アクションには削除を置かない。 */}
          <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
            <button
              type="button"
              className="btn btn--danger"
              style={{ minHeight: 'var(--tap)' }}
              disabled={submitting}
              onClick={() => setPendingDelete(true)}
              data-ui={UI.adjustments.openingEditDelete}
            >
              {t('opening.deleteAction')}
            </button>
            <p className="field__hint">{t('opening.deleteDangerHint')}</p>
          </div>
        </div>
      </Modal>
      {pendingDelete ? (
        <ConfirmDialog
          title={t('opening.deleteConfirmTitle')}
          body={t('opening.deleteConfirmBody')}
          confirmLabel={t('common.delete')}
          danger
          dataUi={UI.adjustments.openingDeleteConfirm}
          onCancel={() => setPendingDelete(false)}
          onConfirm={async () => {
            setPendingDelete(false);
            await deleteOpening(entry.id).catch(() => undefined);
            onClose();
          }}
        />
      ) : null}
    </>
  );
}
