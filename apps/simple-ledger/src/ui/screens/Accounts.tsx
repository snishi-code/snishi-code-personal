/*
 * 勘定科目。アプリが守る「大きな箱」と、その内訳を管理する画面。
 *
 * - 箱そのもの（大分類）はユーザーが追加・削除・移動できない。
 * - ユーザーは箱の中の内訳だけを追加・名前変更・アーカイブできる（削除は出さない）。
 * - 資産・負債の内訳行には残高補正の導線を置く（補正は対象科目が決まってから行う操作のため）。
 * - 登録済みの初期残高・補正の履歴はこの画面に置かず、仕訳一覧に委ねる。
 * - 初期残高(equity)・内部集約 role は聖域として表示しない。残高調整(system-adjustment)は
 *   収入・費用の内訳として表示だけする（「自動」バッジ付き・管理操作は出さない）。
 * - 費用・収入の内訳はヘッダー期間（ホームと同じ選択期間）の発生額、資産・負債は
 *   スライス時点の残高を表示する。期間途中で終了した費用・収入も、期間内の発生額が
 *   あれば一覧に出す（期間末の一点で絞らない・監査 P1-3）。
 */
import { useState, type CSSProperties } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../../state/store';
import {
  accountBalance,
  accountHasEntries,
  filterByDateRange,
  summarizeEntriesForAccount,
} from '../../domain/accounting';
import { isDebitNormal } from '../../domain/accounting';
import { referencedAccountIds } from '../../domain/accountRefs';
import { displayEntriesResultForAsOf } from '../../domain/reportEntries';
import { reportBasis, type ReportPeriod } from '../../domain/reportPeriod';
import { buildSimpleEntry } from '../../domain/entry';
import type { Account } from '../../domain/types';
import { accountExistsAt } from '../../domain/accountLifetime';
import { isRecurringPostableRole } from '../../domain/recurring';
import { groupAccountsByBox, type AccountBox } from '../accountBoxes';
import { AccountSheet } from './AccountSheet';
import { AdjustmentCreateSheet } from '../AdjustmentSheet';
import { OpeningRegisterSheet } from '../OpeningSheet';
import { EntrySheet } from './EntrySheet';
import { Money } from '../money';
import { periodLabel } from '../periodLabel';
import { nowIso, todayLocal } from '../../util/time';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import { ScrollTopButton } from '../ScrollTopButton';
import { InvestmentProjectionTruncationNotice } from '../components/InvestmentProjectionTruncationNotice';

export function Accounts({
  period = { mode: 'all' },
  target,
}: {
  period?: ReportPeriod;
  /** 投影行タップからの遷移対象（開く編集シート。同一オブジェクトは 1 回だけ消費）。 */
  target?: { accountId: string } | null;
}) {
  const { ledger, saveAccount, archiveAccount, reorderAccounts } = useLedger();
  const [editing, setEditing] = useState<Account | null>(null);
  // 仕訳一覧・タイムラインの投影行タップからの遷移: 対象科目の編集シートを開く。
  // effect ではなく「render 中の派生調整」パターン（Allocations と同じ・1 回だけ消費）。
  const [consumedTarget, setConsumedTarget] = useState<{ accountId: string } | null>(null);
  if (target != null && target !== consumedTarget && ledger) {
    setConsumedTarget(target);
    const targetAccount = ledger.accounts.find((account) => account.id === target.accountId);
    if (targetAccount) setEditing(targetAccount);
  }
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
  const basis = reportBasis(period, today);
  const asOf = basis.asOf;
  const display = ledger ? displayEntriesResultForAsOf(ledger, asOf, today) : null;
  const entries = filterByDateRange(display?.entries ?? [], undefined, asOf);
  // 費用・収入の発生額はホームと同じ期間（flowRange）で数える（C-1。導出＝統一エンジン）。
  const flowEntries = filterByDateRange(entries, basis.flowRange.from, basis.flowRange.to);
  const todayDisplay = ledger ? displayEntriesResultForAsOf(ledger, today, today) : null;
  const todayEntries = filterByDateRange(todayDisplay?.entries ?? [], undefined, today);
  const currency = ledger?.settings.currency ?? '';

  const usedIds = referencedAccountIds({
    entries: ledger?.journalEntries ?? [],
    monthlyCostItems: ledger?.monthlyCostItems ?? [],
    recurringRules: ledger?.recurringRules ?? [],
  });

  // 費用・収入は期間途中で終了しても、期間内の発生額 ≠ 0 なら一覧に出す（監査 P1-3）。
  const groups = groupAccountsByBox(
    ledger?.accounts ?? [],
    showArchived,
    asOf,
    (account) => summarizeEntriesForAccount(account, flowEntries, () => true).total !== 0,
  );

  function beginArchiveTransfer(account: Account): void {
    const balance = accountBalance(account.id, account.type, todayEntries);
    const debitBalance = isDebitNormal(account.type) ? balance : -balance;
    setArchiveTransfer({ account, debitBalance });
  }

  async function toggleArchive(account: Account) {
    try {
      if (account.archived) {
        // アーカイブ解除は終了点も同時に消し、未来へ再び延ばす。
        const restored: Account = {
          ...account,
          archived: false,
          endDate: undefined,
          updatedAt: nowIso(),
        };
        await saveAccount(restored);
        return;
      }
      // 資産・負債だけは「終了点の残高 = 0」。費用・収入の累計は過去の記録なので
      // 残したまま終了でき、必要な場合だけ別ボタンから任意振替する。
      // 判定は保存境界（archiveAccount）と同じ「導出仕訳（継続コストの費用行・定期ルールの
      // 投影込み）の今日時点残高」で行う（画面に見えている残高と一致させる・監査 P1-2）。
      const balance = accountBalance(account.id, account.type, todayEntries);
      if ((account.type === 'asset' || account.type === 'liability') && balance !== 0) {
        beginArchiveTransfer(account);
        return;
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

      <InvestmentProjectionTruncationNotice
        truncations={display?.investmentProjectionTruncations ?? []}
        accounts={ledger?.accounts ?? []}
      />

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
          style={{ minHeight: 'var(--tap)' }}
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
          const isFlowBox = box.type === 'revenue' || box.type === 'expense';
          return (
            <div key={box.key}>
              <div
                className="account-box__head"
                style={{ '--account-accent': box.accent } as CSSProperties}
                data-ui={`${UI.accounts.box}.${box.key}`}
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
                    const existsAtSlice = accountExistsAt(account, asOf);
                    // 残高調整科目は表示だけ（管理操作・並び替えの対象にしない）。
                    const isSystemManaged = account.role === 'system-adjustment';
                    const orderable = accounts.filter(
                      (a) => accountExistsAt(a, asOf) && a.role !== 'system-adjustment',
                    );
                    const orderIndex = orderable.findIndex((a) => a.id === account.id);
                    return (
                      <li key={account.id} className="list__item">
                        <div className="list__main">
                          <div className="list__title account-list__title">
                            <span>{account.name}</span>
                            {isSystemManaged ? (
                              <span className="tag tag--neutral" data-ui={UI.accounts.systemBadge}>
                                {t('accounts.autoBadge')}
                              </span>
                            ) : null}
                            {account.role === 'daily-asset' && account.movable === false ? (
                              <span
                                className="tag tag--asset-muted"
                                data-ui={UI.accounts.notMovableBadge}
                              >
                                {t('accounts.notMovable')}
                              </span>
                            ) : null}
                            {usedIds.has(account.id) ? (
                              <span className="tag tag--teal">{t('accounts.inUse')}</span>
                            ) : null}
                            {!existsAtSlice ? (
                              <span className="tag tag--neutral">{t('accounts.outsideSlice')}</span>
                            ) : null}
                          </div>
                          <div className="list__sub">
                            {isFlowBox ? (
                              <>
                                {t('accounts.periodAmount', { period: periodLabel(period) })}:{' '}
                                <Money
                                  amount={
                                    summarizeEntriesForAccount(account, flowEntries, () => true)
                                      .total
                                  }
                                  currency={currency}
                                />
                              </>
                            ) : (
                              <>
                                {t('accounts.balance')}:{' '}
                                <Money
                                  amount={accountBalance(account.id, account.type, entries)}
                                  currency={currency}
                                />
                              </>
                            )}
                          </div>
                        </div>
                        {isSystemManaged ? null : reordering ? (
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
                                style={{ minHeight: 'var(--tap)' }}
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
                            {accountExistsAt(account, today) &&
                            (account.type === 'expense' || account.type === 'revenue') &&
                            accountBalance(account.id, account.type, todayEntries) !== 0 ? (
                              <button
                                type="button"
                                className="icon-btn"
                                onClick={() => beginArchiveTransfer(account)}
                                aria-label={`${t('accounts.archiveWithTransfer')}: ${account.name}`}
                              >
                                <Icon name="transfer" size={18} />
                              </button>
                            ) : null}
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
              date: today,
              lockDate: true,
              counterpartRoles: Array.from(
                new Set(
                  (ledger?.accounts ?? [])
                    .filter(
                      (account) =>
                        account.id !== archiveTransfer.account.id &&
                        account.type === archiveTransfer.account.type &&
                        accountExistsAt(account, today) &&
                        isRecurringPostableRole(account.role),
                    )
                    .map((account) => account.role),
                ),
              ),
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
      <ScrollTopButton />
    </section>
  );
}
