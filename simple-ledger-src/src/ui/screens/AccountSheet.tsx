/*
 * 勘定科目の追加/編集シート。
 * type（会計分類）と role（UI 用の役割）を持つ。type を変えると role は既定へリセットする。
 */
import { useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useDirtyGuard } from '../useDirtyGuard';
import { SelectInput, TextArea, TextInput } from '../Field';
import { useLedger } from '../../state/store';
import { ACCOUNT_TYPES, type Account, type AccountType } from '../../domain/types';
import {
  creatableRolesForType,
  defaultCreatableRoleForType,
  defaultRoleForType,
  rolesForType,
  type AccountRole,
} from '../../domain/accountRoles';
import { isProtectedSeedAccount } from '../../data/seed';
import { isAccountReferenced } from '../../domain/accountRefs';
import { newId } from '../../domain/ids';
import { nowIso } from '../../util/time';
import { accountRoleLabel, accountTypeLabel } from '../accountOptions';
import { errorText, t } from '../../i18n';
import { UI } from '../../ui-contract';

export function AccountSheet({ existing, onClose }: { existing?: Account; onClose: () => void }) {
  const { ledger, saveAccount } = useLedger();
  const isCreate = !existing;
  // seed 由来の基本科目（現金・預金・投資・クレジットカード・開始残高 等）は名称・区分・役割を変更させない（聖域化）。
  const isProtected = !!existing && isProtectedSeedAccount(existing);

  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<AccountType>(existing?.type ?? 'expense');
  const [role, setRole] = useState<AccountRole>(
    existing?.role ?? defaultCreatableRoleForType(existing?.type ?? 'expense'),
  );
  const [note, setNote] = useState(existing?.note ?? '');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  // 使用中（仕訳/予定CF/取り置き資金/按分から参照）の科目は区分(type)を変更できない（role は変更可）。
  const inUse =
    !!existing &&
    isAccountReferenced(existing.id, {
      entries: ledger?.journalEntries ?? [],
      schedules: ledger?.cashflowSchedules ?? [],
      reserves: ledger?.reserves ?? [],
      allocations: ledger?.allocations ?? [],
      monthlyCostItems: ledger?.monthlyCostItems ?? [],
    });

  // 新規作成は通常科目（日常資産・投資・カード・収支カテゴリ）に絞る（聖域化）。区分も equity を出さない。
  // 既存科目の編集は従来どおり（特殊科目の表示・整理を維持）。
  const typeChoices = isCreate
    ? ACCOUNT_TYPES.filter((tp) => creatableRolesForType(tp).length > 0)
    : [...ACCOUNT_TYPES];
  const roleChoices = isCreate ? creatableRolesForType(type) : rolesForType(type);
  // 現在の選択値（既存の特殊/内部ロール）が候補に無くても表示を維持する。
  const roleOptionRoles = roleChoices.includes(role) ? roleChoices : [role, ...roleChoices];

  const onTypeChange = (next: AccountType) => {
    setType(next);
    // type を変えたら role を、その type の既定へリセットする（不整合を防ぐ）。
    setRole(isCreate ? defaultCreatableRoleForType(next) : defaultRoleForType(next));
  };

  async function onSave() {
    if (name.trim() === '') {
      setError(t('entry.error.description-required'));
      return;
    }
    setSubmitting(true);
    const ts = nowIso();
    const account: Account = {
      id: existing?.id ?? newId(),
      name: name.trim(),
      type,
      role,
      archived: existing?.archived ?? false,
      ...(note.trim() !== '' ? { note: note.trim() } : {}),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    try {
      await saveAccount(account);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  const snapshot = JSON.stringify({ name, type, role, note });
  const initialSnapshotRef = useRef<string | null>(null);
  if (initialSnapshotRef.current === null) initialSnapshotRef.current = snapshot;
  const dirty = snapshot !== initialSnapshotRef.current;
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

  return (
    <>
      <Modal
        title={existing ? t('accounts.edit') : t('accounts.add')}
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
        {isProtected ? (
          <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
            <span className="tag tag--neutral">{t('accounts.basic')}</span>{' '}
            {t('accounts.basicHint')}
          </p>
        ) : null}
        <TextInput
          label={t('accounts.name')}
          required
          value={name}
          disabled={isProtected}
          onChange={(v) => {
            setName(v);
            setError(undefined);
          }}
          error={error}
        />
        <SelectInput
          label={t('accounts.type')}
          required
          value={type}
          onChange={(v) => onTypeChange(v as AccountType)}
          options={typeChoices.map((tp) => ({ value: tp, label: accountTypeLabel(tp) }))}
          disabled={inUse || isProtected}
          hint={isProtected ? undefined : inUse ? t('accounts.typeLockedHint') : undefined}
          dataUi={UI.accounts.type}
        />
        <SelectInput
          label={t('accounts.role')}
          required
          value={role}
          onChange={(v) => setRole(v as AccountRole)}
          options={roleOptionRoles.map((r) => ({ value: r, label: accountRoleLabel(r) }))}
          disabled={isProtected}
          hint={isProtected ? undefined : t('accounts.roleHint')}
          dataUi={UI.accounts.role}
        />
        <TextArea label={t('accounts.note')} value={note} onChange={setNote} />
      </Modal>
      {discardConfirm}
    </>
  );
}
