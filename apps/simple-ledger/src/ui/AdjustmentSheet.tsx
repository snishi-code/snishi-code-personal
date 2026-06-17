/*
 * 残高補正のシート（作成・編集）。
 * 作成は勘定科目画面の内訳行（資産・負債）から、編集は仕訳一覧の補正行から開く。
 * 補正は「ある日付の実残高に台帳をピン留めする現実アンカー」で、初期残高(opening)とは別物。
 */
import { useMemo, useState } from 'react';
import { Modal } from '@snishi/foundation/ui/Modal';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../state/store';
import { accountBalance, filterByDateRange } from '../domain/accounting';
import { ADJUSTABLE_ACCOUNT_ROLES } from '../domain/accountRoles';
import { groupedAccountsByRole } from './accountOptions';
import { AccountPicker } from './AccountPicker';
import { Money } from './money';
import { todayLocal } from '../util/time';
import type { Account, AccountType, AdjustmentKind, JournalEntry } from '../domain/types';
import { t } from '../i18n';
import { UI } from '../ui-contract';

const KIND_OPTIONS: { value: AdjustmentKind; label: string }[] = [
  { value: 'unknown-balance', label: t('adjust.kind.unknown-balance') },
  { value: 'investment-valuation', label: t('adjust.kind.investment-valuation') },
];

export function AdjustmentCreateSheet({
  account,
  onClose,
}: {
  account: Account;
  onClose: () => void;
}) {
  const { ledger, createAdjustment } = useLedger();
  const currency = ledger?.settings.currency ?? 'JPY';

  const [date, setDate] = useState(todayLocal());
  const [kind, setKind] = useState<AdjustmentKind>('unknown-balance');
  const [actualText, setActualText] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const type = account.type as AccountType;
  const expected = useMemo(
    () =>
      accountBalance(
        account.id,
        type,
        filterByDateRange(ledger?.journalEntries ?? [], undefined, date),
      ),
    [account.id, type, ledger, date],
  );
  const actual = actualText === '' ? null : Number.parseInt(actualText.replace(/[^\d]/g, ''), 10);
  const delta = actual === null ? 0 : actual - expected;

  async function submit() {
    if (actual === null || !Number.isInteger(actual)) {
      setError(t('adjust.error.actual'));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await createAdjustment({ kind, accountId: account.id, date, actualBalance: actual });
      onClose();
    } catch {
      setError(t('toast.error'));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('adjust.createTitle', { name: account.name })}
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
            data-ui={UI.adjustments.save}
          >
            {t('adjust.save')}
          </button>
        </>
      }
    >
      <div className="stack" data-ui={UI.adjustments.createDialog}>
        <p className="field__hint">{t('adjust.intro')}</p>
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        <div className="kv">
          <span className="muted">{t('adjust.account')}</span>
          <span>{account.name}</span>
        </div>
        <SelectInput
          label={t('adjust.kind')}
          value={kind}
          onChange={(v) => setKind(v as AdjustmentKind)}
          options={KIND_OPTIONS}
          dataUi={UI.adjustments.kind}
        />
        {kind === 'investment-valuation' ? (
          <p className="field__hint">{t('adjust.investmentNote')}</p>
        ) : null}
        <TextInput
          label={t('adjust.date')}
          type="date"
          value={date}
          onChange={setDate}
          dataUi={UI.adjustments.date}
        />
        <TextInput
          label={t('adjust.actual')}
          required
          inputMode="numeric"
          value={actualText}
          onChange={(v) => setActualText(v.replace(/[^\d]/g, ''))}
          dataUi={UI.adjustments.actual}
        />
        <div className="kv">
          <span className="muted">{t('adjust.expected')}</span>
          <span>
            <Money amount={expected} currency={currency} />
          </span>
        </div>
        <div className="kv">
          <span className="muted">{t('adjust.delta')}</span>
          <span>
            <Money amount={delta} currency={currency} signed />
          </span>
        </div>
        <p className="field__hint">{t('adjust.deltaHint')}</p>
      </div>
    </Modal>
  );
}

export function AdjustmentEditSheet({
  entry,
  onClose,
}: {
  entry: JournalEntry;
  onClose: () => void;
}) {
  const { ledger, updateAdjustment } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? 'JPY';
  const adj = entry.metadata!.adjustment!;

  const [accountId, setAccountId] = useState(adj.accountId);
  const [date, setDate] = useState(entry.date);
  const [kind, setKind] = useState<AdjustmentKind>(adj.kind);
  const [actualText, setActualText] = useState(String(adj.actualBalance));
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const target = accounts.find((a: Account) => a.id === accountId);
  const adjustable = target?.type === 'asset' || target?.type === 'liability';

  const expected = useMemo(() => {
    if (!target || !adjustable) return 0;
    const others = (ledger?.journalEntries ?? []).filter((e) => e.id !== entry.id);
    return accountBalance(accountId, target.type, filterByDateRange(others, undefined, date));
  }, [accountId, target, adjustable, ledger, date, entry.id]);

  const actual = actualText === '' ? null : Number.parseInt(actualText.replace(/[^\d]/g, ''), 10);
  const delta = actual === null ? 0 : actual - expected;
  // 補正対象は内部集約口座（取り置き資金・継続コスト台帳）を除いた資産・負債のみ（聖域化）。
  const groups = groupedAccountsByRole(accounts, [...ADJUSTABLE_ACCOUNT_ROLES], accountId);

  async function submit() {
    if (!accountId || actual === null) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await updateAdjustment({ id: entry.id, kind, accountId, date, actualBalance: actual });
      onClose();
    } catch {
      setError(t('toast.error'));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('adjust.editTitle')}
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
            data-ui={UI.adjustments.editSave}
          >
            {t('adjust.update')}
          </button>
        </>
      }
    >
      <div className="stack" data-ui={UI.adjustments.editDialog}>
        <p className="field__hint">{t('adjust.editIntro')}</p>
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        <AccountPicker
          label={t('adjust.account')}
          required
          value={accountId}
          groups={groups}
          onChange={setAccountId}
          emptyText={t('adjust.noAccounts')}
          dataUi={UI.adjustments.editAccount}
        />
        <SelectInput
          label={t('adjust.kind')}
          value={kind}
          onChange={(v) => setKind(v as AdjustmentKind)}
          options={KIND_OPTIONS}
          dataUi={UI.adjustments.editKind}
        />
        {kind === 'investment-valuation' ? (
          <p className="field__hint">{t('adjust.investmentNote')}</p>
        ) : null}
        <TextInput
          label={t('adjust.date')}
          type="date"
          value={date}
          onChange={setDate}
          dataUi={UI.adjustments.editDate}
        />
        <TextInput
          label={t('adjust.actual')}
          required
          inputMode="numeric"
          value={actualText}
          onChange={(v) => setActualText(v.replace(/[^\d]/g, ''))}
          dataUi={UI.adjustments.editActual}
        />
        <div className="kv">
          <span className="muted">{t('adjust.expected')}</span>
          <span>
            <Money amount={expected} currency={currency} />
          </span>
        </div>
        <div className="kv">
          <span className="muted">{t('adjust.delta')}</span>
          <span>
            <Money amount={delta} currency={currency} signed />
          </span>
        </div>
        <p className="field__hint">{t('adjust.deltaHint')}</p>
      </div>
    </Modal>
  );
}
