/*
 * 勘定科目。アプリが守る「大きな箱」と、その内訳を管理する画面。
 *
 * - 箱そのもの（大分類）はユーザーが追加・削除・移動できない。
 * - ユーザーは箱の中の内訳だけを追加・名前変更・アーカイブできる（削除は出さない）。
 * - 内訳行には残高補正の導線を置く（補正は対象科目が決まってから行う操作のため）。資産・負債は
 *   残高、費用・収入はその日までの累計を実額へ合わせる（作者決定 2026-08-15・UI を分散させない）。
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
import { isAdjustableAccountType } from '../../domain/adjustment';
import type { Account } from '../../domain/types';
import { accountExistsAt } from '../../domain/accountLifetime';
import { isRecurringPostableRole } from '../../domain/recurring';
import { boxForAccount, groupAccountsByBox, type AccountBox } from '../accountBoxes';
import { cardTapProps, rowActionClick } from '../cardTap';
import { ConfirmDialog } from '../overlays';
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
  // 状態を変える操作は必ず確認を挟む（2026-08-15 作者合意）。残高 0 のアーカイブと解除は
  // 即実行だったので確認ダイアログを通す（残高が残る経路は振替シート自体が確認を兼ねる）。
  const [pendingArchive, setPendingArchive] = useState<Account | null>(null);
  const [pendingUnarchive, setPendingUnarchive] = useState<Account | null>(null);

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

  /** アーカイブ/解除の入口。実行はいずれも確認（確認ダイアログ or 振替シート）の後。 */
  function toggleArchive(account: Account): void {
    if (account.archived) {
      setPendingUnarchive(account);
      return;
    }
    // 資産・負債は「終了点の残高 = 0」が必須 = 残高が残るなら振替シートを必ず挟む。
    // 費用・収入の累計は過去の記録なので残したまま終了できるが、UI は分散させない
    // （作者決定 2026-08-14）: 同じアーカイブボタン → 同じ振替シートを出し、
    // 最上部の「振替せずにアーカイブ」で任意スキップできる形にする。
    // 判定は保存境界（archiveAccount）と同じ「導出仕訳込みの今日時点残高」（監査 P1-2）。
    const balance = accountBalance(account.id, account.type, todayEntries);
    if (balance !== 0) {
      beginArchiveTransfer(account);
      return;
    }
    setPendingArchive(account);
  }

  async function unarchive(account: Account): Promise<void> {
    // アーカイブ解除は終了点も同時に消し、未来へ再び延ばす。
    const restored: Account = {
      ...account,
      archived: false,
      endDate: undefined,
      updatedAt: nowIso(),
    };
    // エラーは store が toast 済み（握り潰さず、ここでは未処理拒否だけ防ぐ）。
    await saveAccount(restored).catch(() => undefined);
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
          // 補正は資産・負債・費用・収入の 4 箱すべてに置く（equity の箱は存在しない）。
          // 残高調整科目の行は下の isSystemManaged で行アクションごと出さない。
          const canAdjust = isAdjustableAccountType(box.type);
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
                      // 行そのものをタップ = その科目の編集シート（カードタップ = 編集の単一正本）。
                      // 表示だけの残高調整科目と、並び替え中（管理操作を出さない間）は押せない。
                      <li key={account.id}>
                        <div
                          className="list__item"
                          {...(isSystemManaged || reordering
                            ? {}
                            : cardTapProps(`${t('common.edit')}: ${account.name}`, () =>
                                setEditing(account),
                              ))}
                        >
                          <div className="list__main">
                            <div className="list__title account-list__title">
                              <span>{account.name}</span>
                              {usedIds.has(account.id) ? (
                                <span className="tag tag--teal">{t('accounts.inUse')}</span>
                              ) : null}
                              {!existsAtSlice ? (
                                <span className="tag tag--neutral">
                                  {t('accounts.outsideSlice')}
                                </span>
                              ) : null}
                            </div>
                            {/* 金額は右列へ移したので、ここは何の額かのラベルだけを残す。 */}
                            <div className="list__sub">
                              {isFlowBox
                                ? t('accounts.periodAmount', { period: periodLabel(period) })
                                : t('accounts.balance')}
                            </div>
                          </div>
                          {/* 右列 = 上段 金額 / 下段 操作（または状態）。月割り台帳の行と同じ設計図。 */}
                          <div className="row-trailing">
                            <span className="list__amount">
                              {isFlowBox ? (
                                <Money
                                  amount={
                                    summarizeEntriesForAccount(account, flowEntries, () => true)
                                      .total
                                  }
                                  currency={currency}
                                />
                              ) : (
                                <Money
                                  amount={accountBalance(account.id, account.type, entries)}
                                  currency={currency}
                                />
                              )}
                            </span>
                            {isSystemManaged /* 残高調整科目は表示だけ。操作の代わりに「自動」を
                                 同じ位置へ置く（縦揃えを崩さず、操作が無い理由も読める）。 */ ? (
                              <span className="tag tag--neutral" data-ui={UI.accounts.systemBadge}>
                                {t('accounts.autoBadge')}
                              </span>
                            ) : reordering ? (
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
                                    className="btn btn--tonal"
                                    onClick={rowActionClick(() => setAdjustingAccount(account))}
                                    aria-label={`${t('adjust.rowAction')}: ${account.name}`}
                                    data-ui={UI.accounts.adjust}
                                  >
                                    {t('adjust.rowAction')}
                                  </button>
                                ) : null}
                                {/* 動詞は「終了 / 終了を解除」の文字ボタン（v13.2: アイコンを撤去）。 */}
                                <button
                                  type="button"
                                  className="btn btn--tonal"
                                  onClick={rowActionClick(() => toggleArchive(account))}
                                  aria-label={`${
                                    account.archived
                                      ? t('accounts.unarchive')
                                      : t('accounts.archive')
                                  }: ${account.name}`}
                                  data-ui={UI.accounts.archiveToggle}
                                >
                                  {account.archived
                                    ? t('accounts.unarchive')
                                    : t('accounts.archive')}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
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
              // 費用・収入だけ「振替せずにアーカイブ」を選べる（累計は残してよい）。
              // 資産・負債には渡さない = 残高 0 必須の fail-closed を迂回させない。
              ...(archiveTransfer.account.type === 'expense' ||
              archiveTransfer.account.type === 'revenue'
                ? {
                    skip: {
                      label: t('accounts.archiveSkipTransfer'),
                      run: async () => {
                        await archiveAccount(archiveTransfer.account.id);
                      },
                    },
                  }
                : {}),
              onSave: async (input) => {
                // 振替仕訳の保存 + archived=true を 1 トランザクションで（キャンセルなら何もしない）。
                await archiveAccount(archiveTransfer.account.id, buildSimpleEntry(input));
              },
            },
          }}
          onClose={() => setArchiveTransfer(null)}
        />
      ) : null}

      {pendingArchive ? (
        <ConfirmDialog
          title={t('accounts.archiveConfirmTitle')}
          body={t('accounts.archiveConfirmBody', { name: pendingArchive.name })}
          confirmLabel={t('accounts.archive')}
          dataUi={UI.accounts.archiveConfirm}
          onCancel={() => setPendingArchive(null)}
          onConfirm={async () => {
            const account = pendingArchive;
            setPendingArchive(null);
            await archiveAccount(account.id).catch(() => undefined);
          }}
        />
      ) : null}

      {pendingUnarchive ? (
        <ConfirmDialog
          title={t('accounts.unarchiveConfirmTitle')}
          body={t('accounts.unarchiveConfirmBody', { name: pendingUnarchive.name })}
          confirmLabel={t('accounts.unarchive')}
          dataUi={UI.accounts.unarchiveConfirm}
          onCancel={() => setPendingUnarchive(null)}
          onConfirm={async () => {
            const account = pendingUnarchive;
            setPendingUnarchive(null);
            await unarchive(account);
          }}
        />
      ) : null}

      {creatingIn ? <AccountSheet box={creatingIn} onClose={() => setCreatingIn(null)} /> : null}
      {editing ? <AccountSheet existing={editing} onClose={() => setEditing(null)} /> : null}
      {adjustingAccount ? (
        // 履歴が全く無い科目への実残高入力は補正（差分が収入/費用扱い）ではなく
        // 初期残高として登録する。履歴があれば従来どおり補正。
        // 初期残高を持てるのは資産・負債だけなので、費用・収入は履歴ゼロでも補正へ回す
        // （opening の保存境界が必ず弾く行き止まりへ送らない）。
        accountHasEntries(entries, adjustingAccount.id) ||
        boxForAccount(adjustingAccount)?.opening !== true ? (
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
