/*
 * 管理区分（個人用/事業用/家族用）と支払い手段の細目の管理画面。
 */
import { useState } from 'react';
import { Modal } from '@snishi/foundation/ui/Modal';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { useLedger } from '../../state/store';
import type { AccountInstrument, AccountInstrumentKind } from '../../domain/types';
import { isInstrumentParentRole } from '../../domain/accountRoles';
import { DEFAULT_MANAGEMENT_SCOPE_ID } from '../../domain/constants';
import { errorText, t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { UI } from '../../ui-contract';

const INSTRUMENT_KINDS: AccountInstrumentKind[] = ['bank', 'card', 'prepaid', 'cash', 'other'];

export function Wallets() {
  const { ledger, createManagementScope, removeManagementScope } = useLedger();
  const scopes = ledger?.managementScopes ?? [];
  const instruments = ledger?.accountInstruments ?? [];
  const accounts = (ledger?.accounts ?? []).filter(
    (a) => isInstrumentParentRole(a.role) && !a.archived,
  );
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  const scopeName = (id: string) => scopes.find((s) => s.id === id)?.name ?? id;

  const [scopeName2, setScopeName2] = useState('');
  const [scopeError, setScopeError] = useState<string | undefined>(undefined);
  const [pendingScopeDelete, setPendingScopeDelete] = useState<string | null>(null);
  const [instrumentCreating, setInstrumentCreating] = useState(false);
  const [pendingInstrumentDelete, setPendingInstrumentDelete] = useState<AccountInstrument | null>(
    null,
  );

  async function addScope() {
    if (scopeName2.trim() === '') {
      setScopeError(t('error.common.nameRequired'));
      return;
    }
    try {
      await createManagementScope(scopeName2);
      setScopeName2('');
      setScopeError(undefined);
    } catch (e) {
      setScopeError(errorText(e));
    }
  }

  return (
    <section aria-labelledby="wallets-title" data-ui={UI.wallets.view}>
      <h1 className="screen-title" id="wallets-title">
        {t('wallets.title')}
      </h1>
      <p className="field__hint">{t('wallets.intro')}</p>

      {/* 管理区分 */}
      <p className="section-label">{t('wallets.scope.title')}</p>
      <p className="field__hint">{t('wallets.scope.intro')}</p>
      {scopes.length === 0 ? (
        <div className="card card--pad empty">{t('wallets.scope.empty')}</div>
      ) : (
        <ul className="card list" data-ui={UI.wallets.scopeList}>
          {scopes.map((s) => (
            <li key={s.id} className="list__item">
              <div className="list__main">
                <div className="list__title">{s.name}</div>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setPendingScopeDelete(s.id)}
                  aria-label={`${t('common.delete')}: ${s.name}`}
                  disabled={scopes.length <= 1 || s.id === DEFAULT_MANAGEMENT_SCOPE_ID}
                >
                  <Icon name="delete" size={18} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="toolbar" style={{ marginTop: 'var(--space-2)' }}>
        <TextInput
          label={t('wallets.scope.name')}
          value={scopeName2}
          placeholder={t('wallets.scope.namePlaceholder')}
          onChange={(v) => {
            setScopeName2(v);
            setScopeError(undefined);
          }}
          error={scopeError}
          dataUi={UI.wallets.scopeName}
        />
        <button
          type="button"
          className="btn btn--primary"
          onClick={addScope}
          data-ui={UI.wallets.scopeCreate}
        >
          <Icon name="add" size={18} />
          {t('wallets.scope.add')}
        </button>
      </div>

      {/* 支払い手段の細目 */}
      <p className="section-label" style={{ marginTop: 'var(--space-4)' }}>
        {t('wallets.instrument.title')}
      </p>
      <p className="field__hint">{t('wallets.instrument.intro')}</p>
      {accounts.length === 0 ? (
        <div className="card card--pad empty">{t('wallets.instrument.noAccounts')}</div>
      ) : (
        <>
          {instruments.length === 0 ? (
            <div className="card card--pad empty">{t('wallets.instrument.empty')}</div>
          ) : (
            <ul className="card list" data-ui={UI.wallets.instrumentList}>
              {instruments.map((inst) => (
                <li key={inst.id} className="list__item">
                  <div className="list__main">
                    <div className="list__title">{inst.name}</div>
                    <div className="list__sub">
                      {accountName(inst.accountId)}
                      {scopes.length > 1 ? `・${scopeName(inst.managementScopeId)}` : ''}
                    </div>
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setPendingInstrumentDelete(inst)}
                      aria-label={`${t('common.delete')}: ${inst.name}`}
                    >
                      <Icon name="delete" size={18} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="btn btn--primary"
            style={{ marginTop: 'var(--space-2)' }}
            onClick={() => setInstrumentCreating(true)}
            data-ui={UI.wallets.instrumentCreate}
          >
            <Icon name="add" size={18} />
            {t('wallets.instrument.add')}
          </button>
        </>
      )}

      {pendingScopeDelete ? (
        <ConfirmDialog
          title={t('wallets.scope.deleteConfirmTitle')}
          body={t('wallets.scope.deleteConfirmBody', { name: scopeName(pendingScopeDelete) })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingScopeDelete(null)}
          onConfirm={async () => {
            const id = pendingScopeDelete;
            setPendingScopeDelete(null);
            await removeManagementScope(id).catch(() => undefined);
          }}
        />
      ) : null}
      {pendingInstrumentDelete ? (
        <InstrumentDeleteDialog
          instrument={pendingInstrumentDelete}
          onClose={() => setPendingInstrumentDelete(null)}
        />
      ) : null}
      {instrumentCreating ? <InstrumentSheet onClose={() => setInstrumentCreating(false)} /> : null}
    </section>
  );
}

function InstrumentDeleteDialog({
  instrument,
  onClose,
}: {
  instrument: AccountInstrument;
  onClose: () => void;
}) {
  const { removeAccountInstrument } = useLedger();
  return (
    <ConfirmDialog
      title={t('wallets.instrument.deleteConfirmTitle')}
      body={t('wallets.instrument.deleteConfirmBody', { name: instrument.name })}
      confirmLabel={t('common.delete')}
      danger
      onCancel={onClose}
      onConfirm={async () => {
        onClose();
        await removeAccountInstrument(instrument.id).catch(() => undefined);
      }}
    />
  );
}

function InstrumentSheet({ onClose }: { onClose: () => void }) {
  const { ledger, createAccountInstrument } = useLedger();
  const scopes = ledger?.managementScopes ?? [];
  const accounts = (ledger?.accounts ?? []).filter(
    (a) => isInstrumentParentRole(a.role) && !a.archived,
  );
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [scopeId, setScopeId] = useState(scopes[0]?.id ?? '');
  const [kind, setKind] = useState<AccountInstrumentKind>('card');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (name.trim() === '') {
      setError(t('error.common.nameRequired'));
      return;
    }
    setSubmitting(true);
    try {
      await createAccountInstrument({ name, accountId, managementScopeId: scopeId, kind });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('wallets.instrument.add')}
      onClose={onClose}
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
            data-ui={UI.wallets.instrumentSave}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <TextInput
        label={t('wallets.instrument.name')}
        required
        value={name}
        placeholder={t('wallets.instrument.namePlaceholder')}
        onChange={(v) => {
          setName(v);
          setError(undefined);
        }}
        error={error}
        dataUi={UI.wallets.instrumentName}
      />
      <SelectInput
        label={t('wallets.instrument.account')}
        value={accountId}
        onChange={setAccountId}
        options={accounts.map((a) => ({ value: a.id, label: a.name }))}
        dataUi={UI.wallets.instrumentAccount}
      />
      {scopes.length > 1 ? (
        <SelectInput
          label={t('wallets.instrument.scope')}
          value={scopeId}
          onChange={setScopeId}
          options={scopes.map((s) => ({ value: s.id, label: s.name }))}
        />
      ) : null}
      <SelectInput
        label={t('wallets.instrument.kind')}
        value={kind}
        onChange={(v) => setKind(v as AccountInstrumentKind)}
        options={INSTRUMENT_KINDS.map((k) => ({
          value: k,
          label: t(`wallets.instrument.kind.${k}` as MessageKey),
        }))}
        dataUi={UI.wallets.instrumentKind}
      />
    </Modal>
  );
}
