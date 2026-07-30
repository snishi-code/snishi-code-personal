/*
 * 勘定科目。アプリが守る「大きな箱」と、その内訳を管理する画面。
 *
 * - 箱そのもの（大分類）はユーザーが追加・削除・移動できない。
 * - ユーザーは箱の中の内訳だけを追加・名前変更・アーカイブできる（削除は出さない）。
 * - 資産・負債の内訳行には残高補正の導線を置く（補正は対象科目が決まってから行う操作のため）。
 * - 登録済みの初期残高・補正の履歴はこの画面に置かず、仕訳一覧に委ねる。
 * - 初期残高(equity)・調整用(system-adjustment)・内部集約 role は聖域として表示しない。
 */
import { useMemo, useState } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../../state/store';
import { accountBalance, accountHasEntries, filterByDateRange } from '../../domain/accounting';
import { referencedAccountIds } from '../../domain/accountRefs';
import { reportEntriesForAsOf } from '../../domain/reportEntries';
import { reportBasis } from '../../domain/reportPeriod';
import { buildSimpleEntry } from '../../domain/entry';
import type { Account } from '../../domain/types';
import { groupAccountsByBox, type AccountBox } from '../accountBoxes';
import { AccountSheet } from './AccountSheet';
import { AdjustmentCreateSheet } from '../AdjustmentSheet';
import { OpeningRegisterSheet } from '../OpeningSheet';
import { EntrySheet } from './EntrySheet';
import { Money } from '../money';
import { nowIso, todayLocal } from '../../util/time';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

export function Accounts() {
  const { ledger, saveAccount, archiveAccount, reorderAccounts } = useLedger();
  const [editing, setEditing] = useState<Account | null>(null);
  const [creatingIn, setCreatingIn] = useState<AccountBox | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [adjustingAccount, setAdjustingAccount] = useState<Account | null>(null);
  // 残高が残る科目のアーカイブ: 振替（ホームと同じシート）で残高を 0 にしてから 1 tx で保存する。
  const [archiveTransfer, setArchiveTransfer] = useState<{
    account: Account;
    debitBalance: number;
  } | null>(null);

  const today = todayLocal();
  const entries = useMemo(() => {
    if (!ledger) return [];
    const asOf = reportBasis({ mode: 'all' }, today).asOf;
    return filterByDateRange(reportEntriesForAsOf(ledger, asOf), undefined, asOf);
  }, [ledger, today]);
  const currency = ledger?.settings.currency ?? 'JPY';

  const usedIds = useMemo(
    () =>
      referencedAccountIds({
        entries: ledger?.journalEntries ?? [],
        schedules: ledger?.cashflowSchedules ?? [],
        monthlyCostItems: ledger?.monthlyCostItems ?? [],
      }),
    [ledger],
  );

  const groups = useMemo(
    () => groupAccountsByBox(ledger?.accounts ?? [], showArchived),
    [ledger, showArchived],
  );

  async function toggleArchive(account: Account) {
    try {
      if (account.archived) {
        // アーカイブ解除は残高チェック不要（残高 0 の状態から戻すだけ）。
        await saveAccount({ ...account, archived: false, updatedAt: nowIso() });
        return;
      }
      // 不変条件「アーカイブ済み = 今日時点の残高 0」。残高が残る資産・負債は振替を先に聞く。
      // 判定は保存境界（archiveAccount）と同じ「保存される仕訳の今日時点残高」で行う。
      if (account.type === 'asset' || account.type === 'liability') {
        const saved = filterByDateRange(ledger?.journalEntries ?? [], undefined, today);
        const balance = accountBalance(account.id, account.type, saved);
        if (balance !== 0) {
          // 自然符号 → 借方残高へ正規化: 借方残高が残る側なら貸方（振替元）を対象に固定する。
          const debitBalance = account.type === 'asset' ? balance : -balance;
          setArchiveTransfer({ account, debitBalance });
          return;
        }
      }
      await archiveAccount(account.id);
    } catch {
      // エラーは store が toast 済み（握り潰さず、ここでは未処理拒否だけ防ぐ）。
    }
  }

  // 箱内の非アーカイブ内訳を 1 つ上/下と入れ替え、その並びを sortIndex として保存する
  // （medical のプロブレム並び替えと同じ隣接スワップ+即保存）。
  async function moveAccount(orderable: Account[], index: number, dir: 'up' | 'down') {
    const j = dir === 'up' ? index - 1 : index + 1;
    if (index < 0 || j < 0 || index >= orderable.length || j >= orderable.length) return;
    const ids = orderable.map((a) => a.id);
    const tmp = ids[index]!;
    ids[index] = ids[j]!;
    ids[j] = tmp;
    await reorderAccounts(ids).catch(() => undefined);
  }

  return (
    <section aria-labelledby="accounts-title" data-ui={UI.accounts.view}>
      <h1 className="screen-title" id="accounts-title">
        {t('accounts.title')}
      </h1>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('accounts.intro')}
      </p>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          margin: '0 0 var(--space-4)',
        }}
      >
        <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          {t('accounts.showArchived')}
        </label>
        <button
          type="button"
          className={`btn btn--ghost${reordering ? ' btn--primary' : ''}`}
          style={{ minHeight: 36 }}
          aria-pressed={reordering}
          onClick={() => setReordering((v) => !v)}
          data-ui={UI.accounts.reorderToggle}
        >
          <Icon name="transfer" size={16} />
          {reordering ? t('accounts.reorderDone') : t('accounts.reorder')}
        </button>
      </div>

      <div className="stack" data-ui={UI.accounts.list}>
        {groups.map(({ box, accounts }) => {
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
                  {accounts.map((account) => {
                    const orderable = accounts.filter((a) => !a.archived);
                    const orderIndex = orderable.findIndex((a) => a.id === account.id);
                    return (
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
                        {reordering ? (
                          orderIndex >= 0 ? (
                            <div className="row-actions">
                              <button
                                type="button"
                                className="icon-btn"
                                disabled={orderIndex === 0}
                                onClick={() => moveAccount(orderable, orderIndex, 'up')}
                                aria-label={`${t('accounts.moveUp')}: ${account.name}`}
                                data-ui={UI.accounts.moveUp}
                              >
                                <span aria-hidden="true" style={{ fontSize: 16 }}>
                                  ↑
                                </span>
                              </button>
                              <button
                                type="button"
                                className="icon-btn"
                                disabled={orderIndex === orderable.length - 1}
                                onClick={() => moveAccount(orderable, orderIndex, 'down')}
                                aria-label={`${t('accounts.moveDown')}: ${account.name}`}
                                data-ui={UI.accounts.moveDown}
                              >
                                <span aria-hidden="true" style={{ fontSize: 16 }}>
                                  ↓
                                </span>
                              </button>
                            </div>
                          ) : null
                        ) : (
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
                              data-ui={UI.accounts.archiveToggle}
                            >
                              <Icon name={account.archived ? 'restore' : 'archive'} size={18} />
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {archiveTransfer ? (
        <EntrySheet
          init={{
            kind: 'transfer-fixed',
            fixed: {
              // 借方残高が残る（資産のプラス等）→ 対象を振替元（貸方）に固定。逆は振替先（借方）。
              side: archiveTransfer.debitBalance > 0 ? 'credit' : 'debit',
              accountId: archiveTransfer.account.id,
              amount: Math.abs(archiveTransfer.debitBalance),
              onSave: async (input) => {
                // 振替仕訳の保存 + archived=true を 1 トランザクションで（キャンセルなら何もしない）。
                await archiveAccount(archiveTransfer.account.id, buildSimpleEntry(input));
              },
            },
          }}
          onClose={() => setArchiveTransfer(null)}
        />
      ) : null}

      {creatingIn ? <AccountSheet box={creatingIn} onClose={() => setCreatingIn(null)} /> : null}
      {editing ? <AccountSheet existing={editing} onClose={() => setEditing(null)} /> : null}
      {adjustingAccount ? (
        // 履歴が全く無い科目への実残高入力は補正（差分が収入/費用扱い）ではなく
        // 初期残高として登録する。履歴があれば従来どおり補正。
        accountHasEntries(entries, adjustingAccount.id) ? (
          <AdjustmentCreateSheet
            account={adjustingAccount}
            onClose={() => setAdjustingAccount(null)}
          />
        ) : (
          <OpeningRegisterSheet
            account={adjustingAccount}
            onClose={() => setAdjustingAccount(null)}
          />
        )
      ) : null}
    </section>
  );
}
