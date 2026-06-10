/*
 * 補正・勘定科目（聖域化）。この画面は「勘定科目を見る・通常科目を追加する・各科目の残高を合わせる」に限定する。
 *
 * 初期残高という専用概念は持たない。各 BS 科目行の「残高を合わせる」から実残高を入力すると、その日付の
 * 理論残高との差額を 2 行仕訳で補正する（残高 0 の科目でも「0 からの残高補正」として同じ流れで設定できる）。
 * 通常の現金/預金差額=残高調整、投資残高差額=投資評価損益（支出とは別）。
 *
 * 仕訳や入力フローで扱うべきもの（初期残高一覧・残高補正履歴・特殊科目の直接作成）はここに置かない。
 * 残高補正は仕訳としてそのまま見えるため、この画面で二重に見せない（編集・削除は仕訳側の現実アンカーに委ねる）。
 */
import { useMemo, useState } from 'react';
import { useLedger } from '../../state/store';
import { accountBalance, filterByDateRange } from '../../domain/accounting';
import { Accounts } from './Accounts';
import { SelectInput, TextInput } from '../Field';
import { Money } from '../money';
import { Icon } from '../Icon';
import { Modal } from '../Modal';
import { todayLocal } from '../../util/time';
import type { Account, AccountType, AdjustmentKind } from '../../domain/types';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

const KIND_OPTIONS: { value: AdjustmentKind; label: string }[] = [
  { value: 'unknown-balance', label: t('adjust.kind.unknown-balance') },
  { value: 'investment-valuation', label: t('adjust.kind.investment-valuation') },
];

export function Adjustments() {
  // 各勘定科目行の「残高を合わせる」から開く、その科目を選択済みの補正入力。
  const [adjustingAccount, setAdjustingAccount] = useState<Account | null>(null);

  return (
    <section aria-labelledby="adjust-title" data-ui={UI.adjustments.view}>
      <h1 className="screen-title" id="adjust-title">
        {t('manage.title')}
      </h1>
      <p className="field__hint" style={{ marginBottom: 'var(--space-4)' }}>
        {t('manage.intro')}
      </p>

      {/* 勘定科目の一覧・追加・編集・アーカイブ/削除。各 BS 科目から「残高を合わせる」を開ける。 */}
      <Accounts embedded onAdjust={(a) => setAdjustingAccount(a)} />

      {adjustingAccount ? (
        <AdjustmentCreateSheet
          account={adjustingAccount}
          onClose={() => setAdjustingAccount(null)}
        />
      ) : null}
    </section>
  );
}

/**
 * 各勘定科目行の「残高を合わせる」から開く補正入力。対象科目は固定（選択済み）。
 * 実残高を入れると、その日付の理論残高との差額を 2 行仕訳で補正する（初期残高/残高補正をユーザーに選ばせない）。
 */
function AdjustmentCreateSheet({ account, onClose }: { account: Account; onClose: () => void }) {
  const { ledger, createAdjustment } = useLedger();
  const currency = ledger?.settings.currency ?? 'JPY';

  const [date, setDate] = useState(todayLocal());
  // 投資資産は評価損益、それ以外は残高調整を既定にする（意味を取りやすくする）。
  const [kind, setKind] = useState<AdjustmentKind>(
    account.role === 'investment-asset' ? 'investment-valuation' : 'unknown-balance',
  );
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
