/*
 * 内訳（勘定科目）の追加/編集シート。
 *
 * 呼び出し元の「大きな箱」に固定された内訳編集シートであり、type / role は箱が決める
 * （ユーザーには選ばせない。箱の移動は「新しい内訳を作って古い内訳をアーカイブ」で行う）。
 * 新規作成時、資産・負債の箱では任意の初期残高 + 基準日を入力でき、入力ありなら
 * 「科目作成 + opening 仕訳作成」を createOpening の一経路で同時に行う（新しい永続化概念を増やさない）。
 * 内訳名は箱をまたいでも重複不可。アーカイブ済みとの衝突はユーザー承認のうえ
 * `（アーカイブ）` 付きへ退避してから保存する。
 */
import { useState } from 'react';
import { Modal } from '@snishi/foundation/ui/Modal';
import { useDirtyGuard } from '@snishi/foundation/ui/useDirtyGuard';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { TextArea, TextInput } from '@snishi/foundation/ui/Field';
import { useLedger } from '../../state/store';
import type { Account } from '../../domain/types';
import { findAccountNameConflicts, planArchiveRenames } from '../../domain/accountNames';
import { newId } from '../../domain/ids';
import { nowIso, todayLocal } from '../../util/time';
import { boxForRole, type AccountBox } from '../accountBoxes';
import { errorText, t } from '../../i18n';
import { UI } from '../../ui-contract';

export function AccountSheet({
  box,
  existing,
  onClose,
}: {
  /** 新規作成時の所属先の箱（createRole を持つ箱のみ）。 */
  box?: AccountBox;
  existing?: Account;
  onClose: () => void;
}) {
  const { ledger, saveAccount, createOpening } = useLedger();
  const accounts = ledger?.accounts ?? [];

  // 編集時は既存 role から箱を導く（聖域 role は勘定科目画面に出ないためここへ来ない）。
  const effectiveBox = existing ? boxForRole(existing.role) : box;
  const createRole = box?.createRole;

  const [name, setName] = useState(existing?.name ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [openingAmountText, setOpeningAmountText] = useState('');
  const [openingDate, setOpeningDate] = useState(todayLocal());
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [archiveRename, setArchiveRename] = useState<{ name: string; renamed: string } | null>(
    null,
  );

  // 初期残高は新規作成 × 資産/負債の箱のみ（収入/支出/聖域には出さない）。
  const showOpening = !existing && !!box?.opening;
  const openingAmount =
    openingAmountText === ''
      ? null
      : Number.parseInt(openingAmountText.replace(/[^\d]/g, ''), 10);

  async function doSave(renameArchivedConflicts: boolean) {
    const trimmed = name.trim();
    setSubmitting(true);
    setError(undefined);
    try {
      if (showOpening && openingAmount !== null && box?.createRole) {
        await createOpening({
          newAccount: {
            name: trimmed,
            type: box.type,
            role: box.createRole,
            ...(note.trim() !== '' ? { note: note.trim() } : {}),
          },
          amount: openingAmount,
          date: openingDate,
          ...(renameArchivedConflicts ? { renameArchivedConflicts } : {}),
        });
      } else {
        const type = existing?.type ?? box?.type;
        const role = existing?.role ?? createRole;
        if (!type || !role) return;
        const ts = nowIso();
        const account: Account = {
          id: existing?.id ?? newId(),
          name: trimmed,
          type,
          role,
          archived: existing?.archived ?? false,
          ...(note.trim() !== '' ? { note: note.trim() } : {}),
          createdAt: existing?.createdAt ?? ts,
          updatedAt: ts,
        };
        await saveAccount(account, renameArchivedConflicts ? { renameArchivedConflicts } : {});
      }
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  async function onSave() {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError(t('error.common.nameRequired'));
      return;
    }
    if (!existing && !createRole) return; // 追加できない箱（UI からは到達しない）
    if (
      showOpening &&
      openingAmountText !== '' &&
      (openingAmount === null || !Number.isInteger(openingAmount) || openingAmount < 1)
    ) {
      setError(t('opening.error.amount'));
      return;
    }
    // 内訳名の重複を保存前に判定する（有効と衝突 → エラー、アーカイブと衝突 → 承認ダイアログ）。
    const conflicts = findAccountNameConflicts(accounts, trimmed, existing?.id);
    if (conflicts.active) {
      setError(t('error.account.nameConflict'));
      return;
    }
    if (conflicts.archived.length > 0) {
      const plan = planArchiveRenames(accounts, trimmed, existing?.id);
      setArchiveRename({ name: trimmed, renamed: plan[0]?.newName ?? '' });
      return;
    }
    await doSave(false);
  }

  const snapshot = JSON.stringify({ name, note, openingAmountText, openingDate });
  const [initialSnapshot] = useState(snapshot);
  const dirty = snapshot !== initialSnapshot;
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

  const boxLabel = effectiveBox ? t(effectiveBox.labelKey) : '—';
  const title = existing
    ? t('accounts.edit')
    : t('accounts.addTitle', { box: effectiveBox ? t(effectiveBox.labelKey) : '' });

  return (
    <>
      <Modal
        title={title}
        onClose={requestClose}
        dismissMode="if-clean"
        dataUi={existing ? undefined : UI.accounts.create}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={requestClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={onSave}
              disabled={submitting}
              data-ui={UI.accounts.save}
            >
              {t('common.save')}
            </button>
          </>
        }
      >
        <div className="kv" data-ui={UI.accounts.box}>
          <span className="muted">{t('accounts.boxLabel')}</span>
          <span>{boxLabel}</span>
        </div>
        {existing ? <p className="field__hint">{t('accounts.boxLockedHint')}</p> : null}
        <TextInput
          label={t('accounts.name')}
          required
          value={name}
          onChange={(v) => {
            setName(v);
            setError(undefined);
          }}
          error={error}
        />
        <TextArea label={t('accounts.note')} value={note} onChange={setNote} />
        {showOpening ? (
          <>
            <TextInput
              label={t('accounts.openingAmount')}
              inputMode="numeric"
              value={openingAmountText}
              onChange={(v) => setOpeningAmountText(v.replace(/[^\d]/g, ''))}
              hint={t('accounts.openingHint')}
              dataUi={UI.accounts.openingAmount}
            />
            {openingAmountText !== '' ? (
              <TextInput
                label={t('accounts.openingDate')}
                type="date"
                value={openingDate}
                onChange={setOpeningDate}
                dataUi={UI.accounts.openingDate}
              />
            ) : null}
          </>
        ) : null}
      </Modal>
      {archiveRename ? (
        <ConfirmDialog
          title={t('accounts.archiveRenameTitle')}
          body={t('accounts.archiveRenameBody', {
            name: archiveRename.name,
            renamed: archiveRename.renamed,
          })}
          confirmLabel={t('accounts.archiveRenameConfirm')}
          dataUi={UI.accounts.archiveRenameConfirm}
          onCancel={() => setArchiveRename(null)}
          onConfirm={async () => {
            setArchiveRename(null);
            await doSave(true);
          }}
        />
      ) : null}
      {discardConfirm}
    </>
  );
}
