/*
 * 残高補正。実残高との差分を任意の日に補正する（「締め」は作らない）。
 * 通常の現金/預金差額=残高調整、投資残高差額=投資評価損益（生活コストとは別）。
 */
import { useMemo, useState } from 'react';
import { useLedger } from '../../state/store';
import { accountBalance, filterByDateRange } from '../../domain/accounting';
import { groupedAccounts } from '../accountOptions';
import { AccountPicker } from '../AccountPicker';
import { SelectInput, TextInput } from '../Field';
import { Money } from '../money';
import { Icon } from '../Icon';
import { todayLocal } from '../../util/time';
import type { AdjustmentKind } from '../../domain/types';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

export function Adjustments() {
  const { ledger, createAdjustment } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? 'JPY';

  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [kind, setKind] = useState<AdjustmentKind>('unknown-balance');
  const [actualText, setActualText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const target = accounts.find((a) => a.id === accountId);
  const adjustable = target?.type === 'asset' || target?.type === 'liability';

  const expected = useMemo(() => {
    if (!target || !adjustable) return 0;
    return accountBalance(
      accountId,
      target.type,
      filterByDateRange(ledger?.journalEntries ?? [], undefined, date),
    );
  }, [accountId, target, adjustable, ledger, date]);

  const actual = actualText === '' ? null : Number.parseInt(actualText.replace(/[^\d]/g, ''), 10);
  const delta = actual === null ? 0 : actual - expected;

  const groups = groupedAccounts(accounts, ['asset', 'liability'], accountId);

  async function submit() {
    const e: string[] = [];
    if (!accountId) e.push(t('adjust.error.account'));
    if (actual === null || !Number.isInteger(actual)) e.push(t('adjust.error.actual'));
    setErrors(e);
    if (e.length > 0) return;
    setSubmitting(true);
    try {
      await createAdjustment({ kind, accountId, date, actualBalance: actual ?? 0 });
      setActualText('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="adjust-title" data-ui={UI.adjustments.view}>
      <h1 className="screen-title" id="adjust-title">
        {t('adjust.title')}
      </h1>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('adjust.intro')}
      </p>

      {errors.length > 0 ? (
        <div className="field__error" role="alert" style={{ marginBottom: 'var(--space-3)' }}>
          <Icon name="alert" size={14} />
          {errors[0]}
        </div>
      ) : null}

      <div className="card card--pad">
        <AccountPicker
          label={t('adjust.account')}
          required
          value={accountId}
          groups={groups}
          onChange={setAccountId}
          emptyText={t('adjust.noAccounts')}
          dataUi={UI.adjustments.account}
        />
        <SelectInput
          label={t('adjust.kind')}
          value={kind}
          onChange={(v) => setKind(v as AdjustmentKind)}
          options={[
            { value: 'unknown-balance', label: t('adjust.kind.unknown-balance') },
            { value: 'investment-valuation', label: t('adjust.kind.investment-valuation') },
          ]}
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
          <span className="muted">{t('adjust.actual')}</span>
          <span>{actual === null ? '—' : <Money amount={actual} currency={currency} />}</span>
        </div>
        <div className="kv">
          <span className="muted">{t('adjust.delta')}</span>
          <span>
            <Money amount={delta} currency={currency} signed />
          </span>
        </div>
        <p className="field__hint" style={{ marginTop: 'var(--space-2)' }}>
          {t('adjust.deltaHint')}
        </p>

        <button
          type="button"
          className="btn btn--primary btn--block"
          style={{ marginTop: 'var(--space-3)' }}
          onClick={submit}
          disabled={submitting}
          data-ui={UI.adjustments.save}
        >
          {t('adjust.save')}
        </button>
      </div>
    </section>
  );
}
