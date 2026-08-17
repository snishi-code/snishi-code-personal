/*
 * 残高補正のシート（作成・編集）。
 * 作成は勘定科目画面の内訳行（資産・負債・費用・収入）から、編集は仕訳一覧の補正行から開く。
 * 補正は「ある日付の実残高に台帳をピン留めする現実アンカー」で、初期残高(opening)とは別物。
 * 費用・収入の「実残高」はその日までの実際の累計額（accountBalance が type で符号を決める）。
 */
import { useMemo, useState } from 'react';
import { ConfirmDialog, Modal } from './overlays';
import { TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../state/store';
import { accountBalance, filterByDateRange } from '../domain/accounting';
import { ADJUSTABLE_ACCOUNT_ROLES } from '../domain/accountRoles';
import { isAdjustableAccountType } from '../domain/adjustment';
import { isValidIsoDate } from '../domain/calendar';
// 理論残高は reportEntriesForAsOf を使う: repository の保存側（createAdjustment /
// updateAdjustment）と同じ算定でなければ expectedBalance がずれる。v13.4 ② で投資の
// 利回り導出もこの単一正本に含まれる（利回りは仮の数字ではなく作者の宣言なので、
// 補正の基準にも入る。宣言を打ち直すと、その pin より前の複利は按分に置き換わる）。
import { reportEntriesForAsOf } from '../domain/reportEntries';
import { formatMinorForInput, parseAmountToMinor, sanitizeSignedAmountText } from './amountText';
import { useMoneyDigits } from './money';
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
  const currency = ledger?.settings.currency ?? '';

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
  const digits = useMoneyDigits();
  const actual = parseAmountToMinor(actualText);
  // 表示専用の差分。入力途中の異常値（17 桁など）で render から throw するとアプリ全体が
  // 復旧画面へ落ちるため、ここでは投げない。fail-closed は保存境界
  // （buildAdjustmentEntry の checked 減算）が担う。
  const rawDelta = actual === null ? 0 : actual - expected;
  const delta = Number.isSafeInteger(rawDelta) ? rawDelta : 0;

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
          // 符号付きの欄は inputMode を指定しない: numeric / decimal のソフトキーボードには
          // '-' キーが無く、hint（マイナスは先頭に -）どおりの入力ができなくなる。
          // 「表示桁が inputMode を決める」規約の明示的な例外（AccountSheet の想定利回り欄と同じ趣旨）。
          onChange={(v) => setActualText(sanitizeSignedAmountText(v, digits, actualText))}
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
  const { ledger, updateAdjustment, deleteAdjustment } = useLedger();
  // 破壊的操作は編集シート最下部（動詞体系 v13.1）。行アクションには置かない。
  const [pendingDelete, setPendingDelete] = useState(false);
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? '';
  const adj = entry.metadata!.adjustment!;

  const digits = useMoneyDigits();
  const [accountId, setAccountId] = useState(adj.accountId);
  const [date, setDate] = useState(entry.date);
  // 保存値は minor。テキスト欄には**必ず表示桁で整形して**入れる
  // （生の minor を入れると、無変更で保存し直しただけで 100 倍になる）。
  const initialActualText = formatMinorForInput(adj.actualBalance, digits);
  const [actualText, setActualText] = useState(initialActualText);
  // 変更判定はフラグではなく値で行う: 1 文字打って戻した・除去される文字だけ打った、は
  // 無変更（onChange の発火をもって「変更」とすると、その保存で隠れた端数が丸められる）。
  const actualDirty = actualText !== initialActualText;
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const target = accounts.find((a: Account) => a.id === accountId);
  const adjustable = isAdjustableAccountType(target?.type);

  const expected = useMemo(() => {
    if (!ledger || !target || !adjustable || !isValidIsoDate(date)) return 0;
    const others = (ledger?.journalEntries ?? []).filter((e) => e.id !== entry.id);
    const entries = reportEntriesForAsOf({ ...ledger, journalEntries: others }, date);
    return accountBalance(accountId, target.type, filterByDateRange(entries, undefined, date));
  }, [accountId, target, adjustable, ledger, date, entry.id]);

  // 金額欄を触っていない保存では、粗い表示桁で隠れた minor を失わない。
  const actual = actualDirty ? parseAmountToMinor(actualText) : adj.actualBalance;
  // 表示専用の差分（作成シートと同じ理由で render からは投げない）。
  const rawDelta = actual === null ? 0 : actual - expected;
  const delta = Number.isSafeInteger(rawDelta) ? rawDelta : 0;
  // 補正対象は資産・負債・費用・収入から内部集約口座（継続コスト台帳）と
  // 残高調整科目自身を除いたもの（聖域化・ADJUSTABLE_ACCOUNT_ROLES が正本）。
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
    <>
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
            // 符号付きの欄は inputMode を指定しない: numeric / decimal のソフトキーボードには
            // '-' キーが無く、hint（マイナスは先頭に -）どおりの入力ができなくなる。
            // 「表示桁が inputMode を決める」規約の明示的な例外（AccountSheet の想定利回り欄と同じ趣旨）。
            onChange={(v) => {
              setActualText(sanitizeSignedAmountText(v, digits, actualText));
            }}
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
          {/* 破壊的なほど下（動詞体系 v13.1）。行アクションには削除を置かない。 */}
          <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
            <button
              type="button"
              className="btn btn--danger"
              style={{ minHeight: 'var(--tap)' }}
              disabled={submitting}
              onClick={() => setPendingDelete(true)}
              data-ui={UI.adjustments.editDelete}
            >
              {t('adjust.deleteAction')}
            </button>
            <p className="field__hint">{t('adjust.deleteDangerHint')}</p>
          </div>
        </div>
      </Modal>
      {pendingDelete ? (
        <ConfirmDialog
          title={t('adjust.deleteConfirmTitle')}
          body={t('adjust.deleteConfirmBody')}
          confirmLabel={t('common.delete')}
          danger
          dataUi={UI.adjustments.deleteConfirm}
          onCancel={() => setPendingDelete(false)}
          onConfirm={async () => {
            setPendingDelete(false);
            await deleteAdjustment(entry.id).catch(() => undefined);
            onClose();
          }}
        />
      ) : null}
    </>
  );
}
