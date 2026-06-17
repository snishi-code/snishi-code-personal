/*
 * 勘定科目。アプリが守る「大きな箱」と、その内訳を管理する画面。
 *
 * - 箱そのもの（大分類）はユーザーが追加・削除・移動できない。
 * - ユーザーは箱の中の内訳だけを追加・名前変更・アーカイブできる（削除は出さない）。
 * - 資産・負債の内訳行には残高補正の導線を置く（補正は対象科目が決まってから行う操作のため）。
 * - 登録済みの初期残高・補正の履歴はこの画面に置かず、仕訳一覧に委ねる。
 * - 開始残高(equity)・調整用(system-adjustment)・内部集約 role は聖域として表示しない。
 */
import { useMemo, useState } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../../state/store';
import { accountBalance } from '../../domain/accounting';
import { referencedAccountIds } from '../../domain/accountRefs';
import type { Account } from '../../domain/types';
import { groupAccountsByBox, type AccountBox } from '../accountBoxes';
import { AccountSheet } from './AccountSheet';
import { AdjustmentCreateSheet } from '../AdjustmentSheet';
import { Money } from '../money';
import { nowIso } from '../../util/time';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

export function Accounts() {
  const { ledger, saveAccount } = useLedger();
  const [editing, setEditing] = useState<Account | null>(null);
  const [creatingIn, setCreatingIn] = useState<AccountBox | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [adjustingAccount, setAdjustingAccount] = useState<Account | null>(null);

  const entries = ledger?.journalEntries ?? [];
  const currency = ledger?.settings.currency ?? 'JPY';

  const usedIds = useMemo(
    () =>
      referencedAccountIds({
        entries: ledger?.journalEntries ?? [],
        schedules: ledger?.cashflowSchedules ?? [],
        reserves: ledger?.reserves ?? [],
        allocations: ledger?.allocations ?? [],
        monthlyCostItems: ledger?.monthlyCostItems ?? [],
      }),
    [ledger],
  );

  const groups = useMemo(
    () => groupAccountsByBox(ledger?.accounts ?? [], showArchived),
    [ledger, showArchived],
  );

  async function toggleArchive(account: Account) {
    await saveAccount({ ...account, archived: !account.archived, updatedAt: nowIso() }).catch(
      () => undefined,
    );
  }

  return (
    <section aria-labelledby="accounts-title" data-ui={UI.accounts.view}>
      <h1 className="screen-title" id="accounts-title">
        {t('accounts.title')}
      </h1>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('accounts.intro')}
      </p>

      <label
        style={{ display: 'inline-flex', gap: 8, alignItems: 'center', margin: '0 0 var(--space-4)' }}
      >
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        {t('accounts.showArchived')}
      </label>

      <div className="stack" data-ui={UI.accounts.list}>
        {groups.map(({ box, accounts }) => {
          // 追加導線のない箱（継続コスト資産）は、内訳が無ければ行ごと出さない。
          if (!box.createRole && accounts.length === 0) return null;
          const canAdjust = box.type === 'asset' || box.type === 'liability';
          return (
            <div key={box.key}>
              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
              >
                <p className="section-label" style={{ marginBottom: 0 }}>
                  {t(box.labelKey)}
                </p>
                {box.createRole && box.addLabelKey ? (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setCreatingIn(box)}
                    aria-label={`${t(box.labelKey)}: ${t(box.addLabelKey)}`}
                    data-ui={UI.accounts.create}
                  >
                    <Icon name="add" size={16} />
                    {t(box.addLabelKey)}
                  </button>
                ) : null}
              </div>
              {box.hintKey ? (
                <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
                  {t(box.hintKey)}
                </p>
              ) : null}
              {accounts.length === 0 ? (
                <div className="card card--pad empty">{t('accounts.emptyBox')}</div>
              ) : (
                <ul className="card list">
                  {accounts.map((account) => (
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
                          {t('accounts.balance')}:{' '}
                          <Money
                            amount={accountBalance(account.id, account.type, entries)}
                            currency={currency}
                          />
                        </div>
                      </div>
                      <div className="row-actions">
                        {canAdjust ? (
                          <button
                            type="button"
                            className="btn btn--ghost"
                            style={{ minHeight: 36 }}
                            onClick={() => setAdjustingAccount(account)}
                            aria-label={`${t('adjust.rowAction')}: ${account.name}`}
                            data-ui={UI.accounts.adjust}
                          >
                            <Icon name="adjust" size={16} />
                            {t('adjust.rowAction')}
                          </button>
                        ) : null}
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
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {creatingIn ? <AccountSheet box={creatingIn} onClose={() => setCreatingIn(null)} /> : null}
      {editing ? <AccountSheet existing={editing} onClose={() => setEditing(null)} /> : null}
      {adjustingAccount ? (
        <AdjustmentCreateSheet
          account={adjustingAccount}
          onClose={() => setAdjustingAccount(null)}
        />
      ) : null}
    </section>
  );
}
