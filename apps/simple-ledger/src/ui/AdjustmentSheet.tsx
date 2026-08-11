/*
 * 残高補正のシート（作成・編集）。
 * 作成は勘定科目画面の内訳行（資産・負債）から、編集は仕訳一覧の補正行から開く。
 * 補正は「ある日付の実残高に台帳をピン留めする現実アンカー」で、初期残高(opening)とは別物。
 */
import { useMemo, useState } from 'react';
import { Modal } from './overlays';
import { TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../state/store';
import { accountBalance, filterByDateRange } from '../domain/accounting';
import { ADJUSTABLE_ACCOUNT_ROLES } from '../domain/accountRoles';
import { isValidIsoDate } from '../domain/calendar';
// 理論残高は意図的に reportEntriesForAsOf（投影なし）を使う: repository の保存側
// （createAdjustment / updateAdjustment）と同じ算定でなければ expectedBalance がずれる。
// 投資利回りの投影（displayEntriesForAsOf）は仮の数字であり、補正の基準（現実アンカー）に
// 混ぜない（§D・Codex 指摘）。
import { reportEntriesForAsOf } from '../domain/reportEntries';
import { parseSignedAmountText, sanitizeSignedAmountText } from './amountText';
import { groupedAccountsByRole } from './accountOptions';
import { AccountPicker } from './AccountPicker';
import { Money } from './money';
import { todayLocal } from '../util/time';
import type { Account, AccountType, JournalEntry } from '../domain/types';
import { t } from '../i18n';
import { UI } from '../ui-contract';

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
  const [actualText, setActualText] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const type = account.type as AccountType;
  const expected = useMemo(() => {
    if (!ledger || !isValidIsoDate(date)) return 0;
    return accountBalance(
      account.id,
      type,
      filterByDateRange(reportEntriesForAsOf(ledger, date), undefined, date),
    );
  }, [account.id, type, ledger, date]);
  const actual = parseSignedAmountText(actualText);
  const delta = actual === null ? 0 : actual - expected;

  async function submit() {
    if (date.trim() === '') {
      setError(t('entry.error.date-required'));
      return;
    }
    if (actual === null || !Number.isInteger(actual)) {
      setError(t('adjust.error.actual'));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await createAdjustment({ accountId: account.id, date, actualBalance: actual });
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
            disabled={submitting || date.trim() === ''}
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
        <TextInput
          label={t('adjust.date')}
          required
          type="date"
          value={date}
          onChange={setDate}
          dataUi={UI.adjustments.date}
        />
        <TextInput
          label={t('adjust.actual')}
          required
          value={actualText}
          onChange={(v) => setActualText(sanitizeSignedAmountText(v))}
          hint={t('common.signedAmountHint')}
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
  const [actualText, setActualText] = useState(String(adj.actualBalance));
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const target = accounts.find((a: Account) => a.id === accountId);
  const adjustable = target?.type === 'asset' || target?.type === 'liability';

  const expected = useMemo(() => {
    if (!ledger || !target || !adjustable || !isValidIsoDate(date)) return 0;
    const others = (ledger?.journalEntries ?? []).filter((e) => e.id !== entry.id);
    const entries = reportEntriesForAsOf({ ...ledger, journalEntries: others }, date);
    return accountBalance(accountId, target.type, filterByDateRange(entries, undefined, date));
  }, [accountId, target, adjustable, ledger, date, entry.id]);

  const actual = parseSignedAmountText(actualText);
  const delta = actual === null ? 0 : actual - expected;
  // 補正対象は内部集約口座（継続コスト台帳）を除いた資産・負債のみ（聖域化）。
  const groups = groupedAccountsByRole(accounts, [...ADJUSTABLE_ACCOUNT_ROLES], accountId);

  async function submit() {
    if (date.trim() === '') {
      setError(t('entry.error.date-required'));
      return;
    }
    if (!accountId || actual === null) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await updateAdjustment({ id: entry.id, accountId, date, actualBalance: actual });
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
            disabled={submitting || date.trim() === ''}
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
        <TextInput
          label={t('adjust.date')}
          required
          type="date"
          value={date}
          onChange={setDate}
          dataUi={UI.adjustments.editDate}
        />
        <TextInput
          label={t('adjust.actual')}
          required
          value={actualText}
          onChange={(v) => setActualText(sanitizeSignedAmountText(v))}
          hint={t('common.signedAmountHint')}
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
