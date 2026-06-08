/*
 * 新しい負債（科目）の作成シート。支出の支払い方法 / 振替の源泉・行き先から、入力を中断せず
 * 単回ローン・分割負債・クレジットカードなどの負債科目をその場で作るための導線。
 *
 * 内部は会計 type=liability。BS 上は負債。種類はユーザーが選ぶ:
 *  - カード等の支払用未払 = payment-liability（支出の支払い方法に出る）
 *  - 借入・ローン = other-liability（振替の源泉=借入実行に出る）
 * 通常入力の候補に大量表示しないため、ここで作った負債は「負債を表示」トグルで現れる。
 */
import { useRef, useState } from 'react';
import { Modal } from './Modal';
import { useDirtyGuard } from './useDirtyGuard';
import { TextInput } from './Field';
import { Icon } from './Icon';
import { newId } from '../domain/ids';
import { nowIso } from '../util/time';
import type { Account } from '../domain/types';
import { t } from '../i18n';
import { UI } from '../ui-contract';

type LiabilityRole = 'payment-liability' | 'other-liability';

export function LiabilitySheet({
  defaultRole = 'other-liability',
  onClose,
  onSave,
}: {
  defaultRole?: LiabilityRole;
  onClose: () => void;
  /** 作成された負債科目を渡す。永続化と選択は呼び出し側が行う。 */
  onSave: (account: Account) => Promise<unknown> | void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<LiabilityRole>(defaultRole);
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (name.trim() === '') {
      setError(t('liability.error.name'));
      return;
    }
    setSubmitting(true);
    const ts = nowIso();
    const account: Account = {
      id: newId(),
      name: name.trim(),
      type: 'liability',
      role,
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    };
    try {
      await onSave(account);
      onClose(); // 成功時のみ閉じる
    } catch {
      setSubmitting(false); // 保存失敗時は閉じない
    }
  }

  const snapshot = JSON.stringify({ name, role });
  const initialSnapshotRef = useRef<string | null>(null);
  if (initialSnapshotRef.current === null) initialSnapshotRef.current = snapshot;
  const dirty = snapshot !== initialSnapshotRef.current;
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

  const roles: { value: LiabilityRole; labelKey: 'liability.role.card' | 'liability.role.loan' }[] =
    [
      { value: 'payment-liability', labelKey: 'liability.role.card' },
      { value: 'other-liability', labelKey: 'liability.role.loan' },
    ];

  return (
    <>
      <Modal
        title={t('liability.form.title')}
        onClose={requestClose}
        dismissMode="if-clean"
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={requestClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={submit}
              disabled={submitting}
              data-ui={UI.journal.entry.liabilityCreateSave}
            >
              {t('common.save')}
            </button>
          </>
        }
      >
        <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
          {t('liability.form.intro')}
        </p>
        <TextInput
          label={t('liability.name')}
          required
          value={name}
          placeholder={t('liability.namePlaceholder')}
          onChange={(v) => {
            setName(v);
            setError(undefined);
          }}
          error={error}
          dataUi={UI.journal.entry.liabilityCreateName}
        />
        <fieldset className="field picker" data-ui={UI.journal.entry.liabilityCreateRole}>
          <legend className="field__label">{t('liability.kind')}</legend>
          <div className="picker__chips">
            {roles.map((r) => (
              <label className="chip" key={r.value}>
                <input
                  type="radio"
                  className="sr-only"
                  name="liability-role"
                  value={r.value}
                  checked={role === r.value}
                  onChange={() => setRole(r.value)}
                />
                <span className="chip__check" aria-hidden="true">
                  <Icon name="check" size={14} />
                </span>
                <span className="chip__text">{t(r.labelKey)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </Modal>
      {discardConfirm}
    </>
  );
}
