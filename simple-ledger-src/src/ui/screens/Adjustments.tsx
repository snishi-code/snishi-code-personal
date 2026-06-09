/*
 * 残高補正。実残高との差分を任意の日に補正する（「締め」は作らない）。
 * 通常の現金/預金差額=残高調整、投資残高差額=投資評価損益（支出とは別）。
 *
 * 残高補正は「現実アンカー」: ある日付の実残高に台帳をピン留めする。過去編集モデルでは、
 * 継続コストや過去仕訳を後から組み替えると過去集計が再計算されるため、補正自体も後から
 * 編集・削除できる必要がある。編集時の理論残高は **補正自身を除いて** 計算する（二重掛け回避）。
 */
import { useMemo, useState } from 'react';
import { useLedger } from '../../state/store';
import { accountBalance, filterByDateRange } from '../../domain/accounting';
import { groupedAccounts } from '../accountOptions';
import { AccountPicker } from '../AccountPicker';
import { Accounts } from './Accounts';
import { SelectInput, TextInput } from '../Field';
import { Money } from '../money';
import { Icon } from '../Icon';
import { Modal } from '../Modal';
import { ConfirmDialog } from '../ConfirmDialog';
import { todayLocal } from '../../util/time';
import type { Account, AccountType, AdjustmentKind, JournalEntry } from '../../domain/types';
import type { AccountRole } from '../../domain/accountRoles';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { UI } from '../../ui-contract';

const KIND_OPTIONS: { value: AdjustmentKind; label: string }[] = [
  { value: 'unknown-balance', label: t('adjust.kind.unknown-balance') },
  { value: 'investment-valuation', label: t('adjust.kind.investment-valuation') },
];

/** 初期残高で作れる BS 科目の役割（資産・負債）。役割→区分はここで固定。 */
const OPENING_ROLES: { role: AccountRole; type: AccountType }[] = [
  { role: 'daily-asset', type: 'asset' },
  { role: 'reserve-asset', type: 'asset' },
  { role: 'investment-asset', type: 'asset' },
  { role: 'fixed-asset', type: 'asset' },
  { role: 'payment-liability', type: 'liability' },
  { role: 'other-liability', type: 'liability' },
];

/** opening 仕訳の BS 側（開始残高=equity でない方）の科目と金額を取り出す。 */
function openingTarget(
  entry: JournalEntry,
  byId: Map<string, Account>,
): { account: Account; amount: number } | null {
  for (const l of entry.lines) {
    const a = byId.get(l.accountId);
    if (a && a.role !== 'equity') return { account: a, amount: l.amount };
  }
  return null;
}

/** 補正仕訳（metadata.adjustment 付き）だけを日付の新しい順に並べる。 */
function adjustmentEntries(entries: JournalEntry[]): JournalEntry[] {
  return entries
    .filter((e) => e.metadata?.adjustment)
    .slice()
    .sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : a.createdAt < b.createdAt ? 1 : -1,
    );
}

export function Adjustments() {
  const { ledger, deleteAdjustment } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? 'JPY';
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '—';

  const [editing, setEditing] = useState<JournalEntry | null>(null);
  const [pendingDelete, setPendingDelete] = useState<JournalEntry | null>(null);
  // 各勘定科目行の「補正」から開く、その科目を選択済みの補正入力。
  const [adjustingAccount, setAdjustingAccount] = useState<Account | null>(null);

  const rows = useMemo(() => adjustmentEntries(ledger?.journalEntries ?? []), [ledger]);

  return (
    <section aria-labelledby="adjust-title" data-ui={UI.adjustments.view}>
      <h1 className="screen-title" id="adjust-title">
        {t('manage.title')}
      </h1>

      {/* 勘定科目の一覧・追加・編集・アーカイブ/削除。各 BS 科目から「補正」を開ける。 */}
      <Accounts embedded onAdjust={(a) => setAdjustingAccount(a)} />

      <OpeningSection />

      <p className="section-label">{t('adjust.listTitle')}</p>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('adjust.listIntro')}
      </p>

      {rows.length === 0 ? (
        <div className="card card--pad empty">{t('adjust.listEmpty')}</div>
      ) : (
        <ul className="card list" data-ui={UI.adjustments.list}>
          {rows.map((entry) => {
            const adj = entry.metadata!.adjustment!;
            return (
              <li key={entry.id} className="list__item" data-ui={UI.adjustments.row}>
                <div className="list__main">
                  <div className="list__title">
                    <span className="tag tag--neutral">{t(`adjust.rowKind.${adj.kind}`)}</span>{' '}
                    {accountName(adj.accountId)}
                  </div>
                  <div className="list__sub">
                    {entry.date}・{t('adjust.expected')}{' '}
                    <Money amount={adj.expectedBalance} currency={currency} />→{t('adjust.actual')}{' '}
                    <Money amount={adj.actualBalance} currency={currency} />（
                    <Money amount={adj.delta} currency={currency} signed />）
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setEditing(entry)}
                  aria-label={`${t('common.edit')}: ${accountName(adj.accountId)}`}
                  data-ui={UI.adjustments.rowEdit}
                >
                  <Icon name="edit" size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setPendingDelete(entry)}
                  aria-label={`${t('common.delete')}: ${accountName(adj.accountId)}`}
                  data-ui={UI.adjustments.rowDelete}
                >
                  <Icon name="trash" size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {adjustingAccount ? (
        <AdjustmentCreateSheet
          account={adjustingAccount}
          onClose={() => setAdjustingAccount(null)}
        />
      ) : null}

      {editing ? <AdjustmentEditSheet entry={editing} onClose={() => setEditing(null)} /> : null}

      {pendingDelete ? (
        <ConfirmDialog
          title={t('adjust.deleteConfirmTitle')}
          body={t('adjust.deleteConfirmBody')}
          confirmLabel={t('common.delete')}
          danger
          dataUi={UI.adjustments.deleteConfirm}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            const e = pendingDelete;
            setPendingDelete(null);
            await deleteAdjustment(e.id).catch(() => undefined);
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * 各勘定科目行の「補正」から開く補正入力。対象科目は固定（選択済み）。
 * 実残高を入れると、その日付の理論残高との差額を 2 行仕訳で補正する（独立フォームの代替）。
 */
function AdjustmentCreateSheet({ account, onClose }: { account: Account; onClose: () => void }) {
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

function AdjustmentEditSheet({ entry, onClose }: { entry: JournalEntry; onClose: () => void }) {
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

  // 理論残高は「編集中の補正自身を除いて」計算する（補正の二重掛けを避ける＝最重要）。
  const expected = useMemo(() => {
    if (!target || !adjustable) return 0;
    const others = (ledger?.journalEntries ?? []).filter((e) => e.id !== entry.id);
    return accountBalance(accountId, target.type, filterByDateRange(others, undefined, date));
  }, [accountId, target, adjustable, ledger, date, entry.id]);

  const actual = actualText === '' ? null : Number.parseInt(actualText.replace(/[^\d]/g, ''), 10);
  const delta = actual === null ? 0 : actual - expected;
  const groups = groupedAccounts(accounts, ['asset', 'liability'], accountId);

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

/** 初期残高（kind='opening'）の登録・一覧・編集・削除。資産/負債の開始時点残高を BS にピン留めする。 */
function OpeningSection() {
  const { ledger, createOpening, deleteOpening } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? 'JPY';
  const byId = useMemo(
    () => new Map((ledger?.accounts ?? []).map((a) => [a.id, a] as const)),
    [ledger],
  );

  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState('');
  const [role, setRole] = useState<AccountRole>('daily-asset');
  const [accountId, setAccountId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState<JournalEntry | null>(null);
  const [pendingDelete, setPendingDelete] = useState<JournalEntry | null>(null);

  const amount = amountText === '' ? null : Number.parseInt(amountText.replace(/[^\d]/g, ''), 10);
  const bsGroups = groupedAccounts(accounts, ['asset', 'liability'], accountId);
  const rows = useMemo(
    () =>
      (ledger?.journalEntries ?? [])
        .filter((e) => e.kind === 'opening')
        .slice()
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    [ledger],
  );

  async function submit() {
    const e: string[] = [];
    if (mode === 'new' && name.trim() === '') e.push(t('opening.error.name'));
    if (mode === 'existing' && !accountId) e.push(t('opening.error.account'));
    if (amount === null || !Number.isInteger(amount) || amount < 1)
      e.push(t('opening.error.amount'));
    setErrors(e);
    if (e.length > 0) return;
    setSubmitting(true);
    try {
      const roleType = OPENING_ROLES.find((r) => r.role === role)?.type ?? 'asset';
      const input =
        mode === 'new'
          ? { newAccount: { name: name.trim(), type: roleType, role }, amount: amount ?? 0, date }
          : { accountId, amount: amount ?? 0, date };
      await createOpening(input);
      setName('');
      setAmountText('');
      setAccountId('');
    } catch {
      // 失敗トーストは store 側で出す。
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <p className="section-label">{t('opening.title')}</p>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('opening.intro')}
      </p>

      {errors.length > 0 ? (
        <div className="field__error" role="alert" style={{ marginBottom: 'var(--space-3)' }}>
          <Icon name="alert" size={14} />
          {errors[0]}
        </div>
      ) : null}

      <div className="card card--pad">
        <SelectInput
          label={t('opening.mode')}
          value={mode}
          onChange={(v) => setMode(v as 'new' | 'existing')}
          options={[
            { value: 'new', label: t('opening.modeNew') },
            { value: 'existing', label: t('opening.modeExisting') },
          ]}
          dataUi={UI.adjustments.openingMode}
        />
        {mode === 'new' ? (
          <>
            <TextInput
              label={t('opening.name')}
              required
              value={name}
              onChange={setName}
              dataUi={UI.adjustments.openingName}
            />
            <SelectInput
              label={t('opening.role')}
              value={role}
              onChange={(v) => setRole(v as AccountRole)}
              options={OPENING_ROLES.map((r) => ({
                value: r.role,
                label: t(`accounts.role.${r.role}` as MessageKey),
              }))}
              dataUi={UI.adjustments.openingRole}
            />
          </>
        ) : (
          <AccountPicker
            label={t('opening.account')}
            required
            value={accountId}
            groups={bsGroups}
            onChange={setAccountId}
            emptyText={t('adjust.noAccounts')}
            dataUi={UI.adjustments.openingAccount}
          />
        )}
        <TextInput
          label={t('opening.amount')}
          required
          inputMode="numeric"
          value={amountText}
          onChange={(v) => setAmountText(v.replace(/[^\d]/g, ''))}
          dataUi={UI.adjustments.openingAmount}
        />
        <TextInput
          label={t('opening.date')}
          type="date"
          value={date}
          onChange={setDate}
          dataUi={UI.adjustments.openingDate}
        />
        <button
          type="button"
          className="btn btn--primary btn--block"
          style={{ marginTop: 'var(--space-3)' }}
          onClick={submit}
          disabled={submitting}
          data-ui={UI.adjustments.openingSave}
        >
          {t('opening.save')}
        </button>
      </div>

      <p className="section-label">{t('opening.listTitle')}</p>
      {rows.length === 0 ? (
        <div className="card card--pad empty">{t('opening.listEmpty')}</div>
      ) : (
        <ul className="card list" data-ui={UI.adjustments.openingList}>
          {rows.map((entry) => {
            const tgt = openingTarget(entry, byId);
            return (
              <li key={entry.id} className="list__item" data-ui={UI.adjustments.openingRow}>
                <div className="list__main">
                  <div className="list__title">{tgt?.account.name ?? '—'}</div>
                  <div className="list__sub">
                    {entry.date}・<Money amount={tgt?.amount ?? 0} currency={currency} />
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setEditing(entry)}
                  aria-label={`${t('common.edit')}: ${tgt?.account.name ?? ''}`}
                  data-ui={UI.adjustments.openingRowEdit}
                >
                  <Icon name="edit" size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setPendingDelete(entry)}
                  aria-label={`${t('common.delete')}: ${tgt?.account.name ?? ''}`}
                  data-ui={UI.adjustments.openingRowDelete}
                >
                  <Icon name="trash" size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {editing ? <OpeningEditSheet entry={editing} onClose={() => setEditing(null)} /> : null}

      {pendingDelete ? (
        <ConfirmDialog
          title={t('opening.deleteConfirmTitle')}
          body={t('opening.deleteConfirmBody')}
          confirmLabel={t('common.delete')}
          danger
          dataUi={UI.adjustments.openingDeleteConfirm}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            const e = pendingDelete;
            setPendingDelete(null);
            await deleteOpening(e.id).catch(() => undefined);
          }}
        />
      ) : null}
    </>
  );
}

function OpeningEditSheet({ entry, onClose }: { entry: JournalEntry; onClose: () => void }) {
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
