/*
 * 勘定科目管理。区分ごとに残高つきで一覧。追加/編集/アーカイブ/削除（参照中は不可）。
 */
import { useMemo, useState } from 'react';
import { useLedger } from '../../state/store';
import { accountBalance } from '../../domain/accounting';
import { ACCOUNT_TYPES, type Account } from '../../domain/types';
import { accountRoleLabel, accountTypeLabel } from '../accountOptions';
import { AccountSheet } from './AccountSheet';
import { ConfirmDialog } from '../ConfirmDialog';
import { Money } from '../money';
import { Icon } from '../Icon';
import { nowIso } from '../../util/time';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

export function Accounts() {
  const { ledger, saveAccount, removeAccount } = useLedger();
  const [editing, setEditing] = useState<Account | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Account | null>(null);

  const entries = ledger?.journalEntries ?? [];
  const currency = ledger?.settings.currency ?? 'JPY';

  // 仕訳から参照されている科目（区分変更・削除ができない）。
  const usedIds = useMemo(() => {
    const set = new Set<string>();
    for (const e of ledger?.journalEntries ?? []) for (const l of e.lines) set.add(l.accountId);
    return set;
  }, [ledger]);

  const byType = useMemo(() => {
    const list = ledger?.accounts ?? [];
    return ACCOUNT_TYPES.map((type) => ({
      type,
      accounts: list
        .filter((a) => a.type === type && (showArchived || !a.archived))
        .sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    })).filter((g) => g.accounts.length > 0);
  }, [ledger, showArchived]);

  async function toggleArchive(account: Account) {
    await saveAccount({ ...account, archived: !account.archived, updatedAt: nowIso() }).catch(
      () => undefined,
    );
  }

  return (
    <section aria-labelledby="accounts-title" data-ui={UI.accounts.view}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 className="screen-title" id="accounts-title" style={{ marginBottom: 0 }}>
          {t('accounts.title')}
        </h1>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setCreating(true)}
          data-ui={UI.accounts.create}
        >
          <Icon name="plus" size={18} />
          {t('accounts.add')}
        </button>
      </div>

      <label
        style={{ display: 'inline-flex', gap: 8, alignItems: 'center', margin: 'var(--space-4) 0' }}
      >
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        {t('accounts.showArchived')}
      </label>

      {byType.length === 0 ? (
        <div className="card card--pad empty">{t('accounts.empty')}</div>
      ) : (
        <div className="stack" data-ui={UI.accounts.list}>
          {byType.map((group) => (
            <div key={group.type}>
              <p className="section-label">{accountTypeLabel(group.type)}</p>
              <ul className="card list">
                {group.accounts.map((account) => (
                  <li key={account.id} className="list__item">
                    <div className="list__main">
                      <div className="list__title">
                        {account.name}{' '}
                        {usedIds.has(account.id) ? (
                          <span className="tag tag--teal">{t('accounts.inUse')}</span>
                        ) : null}{' '}
                        {account.archived ? (
                          <span className="tag tag--neutral">{t('accounts.archived')}</span>
                        ) : null}
                      </div>
                      <div className="list__sub">
                        {accountRoleLabel(account.role)}・{t('accounts.balance')}:{' '}
                        <Money
                          amount={accountBalance(account.id, account.type, entries)}
                          currency={currency}
                        />
                      </div>
                    </div>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setEditing(account)}
                        aria-label={`${t('common.edit')}: ${account.name}`}
                      >
                        <Icon name="edit" size={18} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => toggleArchive(account)}
                        aria-label={`${
                          account.archived ? t('accounts.unarchive') : t('accounts.archive')
                        }: ${account.name}`}
                      >
                        <Icon name={account.archived ? 'restore' : 'archive'} size={18} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setPendingDelete(account)}
                        aria-label={`${t('common.delete')}: ${account.name}`}
                      >
                        <Icon name="trash" size={18} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {creating ? <AccountSheet onClose={() => setCreating(false)} /> : null}
      {editing ? <AccountSheet existing={editing} onClose={() => setEditing(null)} /> : null}
      {pendingDelete ? (
        <ConfirmDialog
          title={t('accounts.deleteConfirmTitle')}
          body={t('accounts.deleteConfirmBody', { name: pendingDelete.name })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            const target = pendingDelete;
            setPendingDelete(null);
            await removeAccount(target.id).catch(() => undefined);
          }}
        />
      ) : null}
    </section>
  );
}
