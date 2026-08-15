/*
 * 内訳（勘定科目）の追加/編集シート。
 *
 * 呼び出し元の「大きな箱」に固定された内訳編集シートであり、type / role は箱が決める
 * （ユーザーには選ばせない。箱の移動は「新しい内訳を作って古い内訳をアーカイブ」で行う）。
 * 新規作成時、資産・負債の箱では任意の初期残高 + 基準日を入力でき、入力ありなら
 * 「科目作成 + opening 仕訳作成」を createOpening の一経路で同時に行う（新しい永続化概念を増やさない）。
 * 内訳名は箱をまたいでも重複不可。アーカイブ済みとの衝突はユーザー承認のうえ
 * `（アーカイブ）` 付きへ退避してから保存する。
 */
import { useState } from 'react';
import { Modal } from '../overlays';
import { useDirtyGuard } from '../overlays';
import { ConfirmDialog } from '../overlays';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { useLedger } from '../../state/store';
import type { Account } from '../../domain/types';
import { findAccountNameConflicts, planArchiveRenames } from '../../domain/accountNames';
import { sortAccounts } from '../../domain/accountOrder';
import {
  annualReturnBpToPercentText,
  parseAnnualReturnPercentText,
} from '../../domain/investmentProjection';
import { newId } from '../../domain/ids';
import { nowIso, todayLocal } from '../../util/time';
import { boxForAccount, type AccountBox } from '../accountBoxes';
import { errorText, t } from '../../i18n';
import { parseAmountToMinor, sanitizeAmountText } from '../amountText';
import { useMoneyDigits } from '../money';
import { UI } from '../../ui-contract';

export function AccountSheet({
  box,
  existing,
  onClose,
}: {
  /** 新規作成時の所属先の箱（createRole を持つ箱のみ）。 */
  box?: AccountBox;
  existing?: Account;
  onClose: () => void;
}) {
  const { ledger, saveAccount, createOpening } = useLedger();
  const accounts = ledger?.accounts ?? [];

  // 編集時は既存 role から箱を導く（聖域 role は勘定科目画面に出ないためここへ来ない）。
  // 既存は movable まで見て所属箱を解決する（現預金は自由/不自由の 2 箱に分かれた）。
  const effectiveBox = existing ? boxForAccount(existing) : box;
  const createRole = box?.createRole;

  const [name, setName] = useState(existing?.name ?? '');
  // メモ入力欄は撤去済みだが、既存の note は保存時にそのまま引き継ぐ（消さない）。
  const [note] = useState(existing?.note ?? '');
  // 「自由に動かせるか」は**箱そのもの**が表す（2 箱化に伴い UI のチェックを撤去・作者決定
  // 2026-08-14）。新規は作成した箱で確定し、既存は保存値を保持する＝箱間の移動導線は持たない
  // （他の箱と同じ「箱は作成時に決まる」ルールに揃える）。
  const movable = existing ? existing.movable !== false : box?.defaultMovable !== false;
  const digits = useMoneyDigits();
  const [openingAmountText, setOpeningAmountText] = useState('');
  const [openingDate, setOpeningDate] = useState(todayLocal());
  const [repaymentAccountId, setRepaymentAccountId] = useState(existing?.repaymentAccountId ?? '');
  const [repaymentDayText, setRepaymentDayText] = useState(
    existing?.repaymentDay !== undefined ? String(existing.repaymentDay) : '',
  );
  // 想定利回り（年率% ⇄ bp・投資科目のみ）。空欄 = 投影なし。計上先とセットで保存する。
  const [annualReturnText, setAnnualReturnText] = useState(
    existing?.annualReturnBp !== undefined
      ? annualReturnBpToPercentText(existing.annualReturnBp)
      : '',
  );
  const [projectionAccountId, setProjectionAccountId] = useState(
    existing?.projectionAccountId ?? '',
  );
  // 開始日欄の契約（§A 案1・作者決定）: 空欄 = undefined = 過去側制限なし。未設定値を
  // createdAt で表示・再保存しない。明示値を空欄へ戻せば startDate を削除できる。
  const [startDate, setStartDate] = useState(existing?.startDate ?? '');
  const [endDate, setEndDate] = useState(
    existing?.endDate ??
      (existing?.archived && /^\d{4}-\d{2}-\d{2}/.test(existing.updatedAt)
        ? existing.updatedAt.slice(0, 10)
        : existing?.archived
          ? todayLocal()
          : ''),
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [archiveRename, setArchiveRename] = useState<{ name: string; renamed: string } | null>(
    null,
  );

  // 初期残高は新規作成 × 資産/負債の箱のみ（収入/支出/聖域には出さない）。
  const showOpening = !existing && !!box?.opening;
  // 「自由に動かせる」チェックは現預金（daily-asset）の内訳のみ。
  const isDailyAsset = (existing?.role ?? createRole) === 'daily-asset';
  // 返済設定は負債（カード・未払 / ローン）の編集時のみ（新規は作成後に編集で設定する）。
  const showRepayment =
    !!existing && (existing.role === 'payment-liability' || existing.role === 'other-liability');
  // 想定利回りは投資科目の編集時のみ（返済設定と同じく、新規は作成後に編集で設定する）。
  const showReturn = !!existing && existing.role === 'investment-asset';
  // 計上先の候補 = 収入科目。サジェスト名（i18n 正本・既定「投資益」）の科目があれば
  // 選択肢の先頭に出す（自動確定はしない＝既定は未設定のまま）。
  const suggestedProjectionName = t('projection.suggestedAccountName');
  const projectionOptions = [
    { value: '', label: t('accounts.repaymentUnset') },
    ...sortAccounts(accounts)
      .filter((a) => a.role === 'income-category' && (!a.archived || a.id === projectionAccountId))
      .sort(
        (a, b) =>
          Number(b.name === suggestedProjectionName) - Number(a.name === suggestedProjectionName),
      )
      .map((a) => ({ value: a.id, label: a.name })),
  ];
  // 計上先がアーカイブ済みだと投影は生成されない（fail-closed）。設定済みに見えるまま
  // 黙って消えないよう、選択中の計上先の状態をここで名乗る。
  const projectionAccountArchived =
    projectionAccountId !== '' && accounts.some((a) => a.id === projectionAccountId && a.archived);
  const annualReturnBp =
    annualReturnText === '' ? null : parseAnnualReturnPercentText(annualReturnText);
  const repaymentOptions = [
    { value: '', label: t('accounts.repaymentUnset') },
    ...sortAccounts(accounts)
      .filter((a) => a.role === 'daily-asset' && (!a.archived || a.id === repaymentAccountId))
      .map((a) => ({ value: a.id, label: a.name })),
  ];
  const repaymentDayOptions = [
    { value: '', label: t('accounts.repaymentUnset') },
    ...Array.from({ length: 31 }, (_, index) => {
      const day = String(index + 1);
      return { value: day, label: day };
    }),
  ];
  const repaymentDay = repaymentDayText === '' ? null : Number.parseInt(repaymentDayText, 10);
  const openingAmount = openingAmountText === '' ? null : parseAmountToMinor(openingAmountText);

  async function doSave(renameArchivedConflicts: boolean) {
    const trimmed = name.trim();
    setSubmitting(true);
    setError(undefined);
    try {
      if (showOpening && openingAmount !== null && box?.createRole) {
        await createOpening({
          newAccount: {
            name: trimmed,
            type: box.type,
            role: box.createRole,
            ...(note.trim() !== '' ? { note: note.trim() } : {}),
            ...(isDailyAsset && !movable ? { movable: false } : {}),
          },
          amount: openingAmount,
          date: openingDate,
          ...(renameArchivedConflicts ? { renameArchivedConflicts } : {}),
        });
      } else {
        const type = existing?.type ?? box?.type;
        const role = existing?.role ?? createRole;
        if (!type || !role) return;
        const ts = nowIso();
        const account: Account = {
          id: existing?.id ?? newId(),
          name: trimmed,
          type,
          role,
          archived: existing ? endDate !== '' : false,
          // 空欄 = undefined をキー付きで渡す（保存境界が「明示解除」として startDate を削除する。
          // 新規は既定 = 空欄なのでキー自体を渡さない）。
          ...(existing ? { startDate: startDate === '' ? undefined : startDate } : {}),
          ...(existing ? { endDate: endDate === '' ? undefined : endDate } : {}),
          ...(note.trim() !== '' ? { note: note.trim() } : {}),
          ...(isDailyAsset && !movable ? { movable: false } : {}),
          ...(showRepayment && repaymentAccountId !== '' ? { repaymentAccountId } : {}),
          ...(showRepayment && repaymentDay !== null ? { repaymentDay } : {}),
          // 想定利回りと計上先は必ずセットで保存する（空欄 = 両方なし = 投影なし）。
          ...(showReturn && annualReturnBp !== null && projectionAccountId !== ''
            ? { annualReturnBp, projectionAccountId }
            : {}),
          createdAt: existing?.createdAt ?? ts,
          updatedAt: ts,
        };
        await saveAccount(account, renameArchivedConflicts ? { renameArchivedConflicts } : {});
      }
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  async function onSave() {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError(t('error.common.nameRequired'));
      return;
    }
    if (!existing && !createRole) return; // 追加できない箱（UI からは到達しない）
    // 開始日は空欄可（過去側制限なし・§A 案1）。両端があるときだけ前後関係を検証する。
    if (existing && startDate !== '' && endDate !== '' && endDate < startDate) {
      setError(t('error.monthlyCost.endBeforeStart'));
      return;
    }
    if (
      showOpening &&
      openingAmountText !== '' &&
      (openingAmount === null || !Number.isInteger(openingAmount) || openingAmount < 1)
    ) {
      setError(t('opening.error.amount'));
      return;
    }
    if (
      showRepayment &&
      repaymentDayText !== '' &&
      (repaymentDay === null ||
        !Number.isInteger(repaymentDay) ||
        repaymentDay < 1 ||
        repaymentDay > 31)
    ) {
      setError(t('error.account.repaymentDayInvalid'));
      return;
    }
    // 想定利回り: 解釈できない/範囲外の入力はエラー。片方だけの設定も保存前に拒否する
    // （保存境界 error.account.projectionPair と同じ不変条件を入力時点で知らせる）。
    if (showReturn && annualReturnText !== '' && annualReturnBp === null) {
      setError(t('error.account.returnInvalid'));
      return;
    }
    if (showReturn && (annualReturnText !== '') !== (projectionAccountId !== '')) {
      setError(t('error.account.projectionPair'));
      return;
    }
    // 内訳名の重複を保存前に判定する（有効と衝突 → エラー、アーカイブと衝突 → 承認ダイアログ）。
    const conflicts = findAccountNameConflicts(accounts, trimmed, existing?.id);
    if (conflicts.active) {
      setError(t('error.account.nameConflict'));
      return;
    }
    if (conflicts.archived.length > 0) {
      const plan = planArchiveRenames(accounts, trimmed, existing?.id);
      setArchiveRename({ name: trimmed, renamed: plan[0]?.newName ?? '' });
      return;
    }
    await doSave(false);
  }

  const snapshot = JSON.stringify({
    name,
    note,
    movable,
    openingAmountText,
    openingDate,
    repaymentAccountId,
    repaymentDayText,
    annualReturnText,
    projectionAccountId,
    startDate,
    endDate,
  });
  const [initialSnapshot] = useState(snapshot);
  const dirty = snapshot !== initialSnapshot;
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

  const boxLabel = effectiveBox ? t(effectiveBox.labelKey) : '—';
  const title = existing
    ? t('accounts.edit')
    : t('accounts.addTitle', { box: effectiveBox ? t(effectiveBox.labelKey) : '' });

  return (
    <>
      <Modal
        title={title}
        onClose={requestClose}
        dismissMode="if-clean"
        dataUi={existing ? undefined : UI.accounts.create}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={requestClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={onSave}
              disabled={submitting}
              data-ui={UI.accounts.save}
            >
              {t('common.save')}
            </button>
          </>
        }
      >
        <div className="kv" data-ui={UI.accounts.box}>
          <span className="muted">{t('accounts.boxLabel')}</span>
          <span>{boxLabel}</span>
        </div>
        {existing ? <p className="field__hint">{t('accounts.boxLockedHint')}</p> : null}
        <TextInput
          label={t('accounts.name')}
          required
          value={name}
          onChange={(v) => {
            setName(v);
            setError(undefined);
          }}
          error={error}
        />
        {/* メモ欄は UI から撤去（2026-07-23 作者指示）。既存メモは note state 経由で保持される。 */}
        {existing ? (
          <div className="form-grid form-grid--2">
            <TextInput
              label={t('ccItem.startDate')}
              type="date"
              value={startDate}
              onChange={(value) => {
                setStartDate(value);
                setError(undefined);
              }}
              hint={t('accounts.startDateHint')}
              dataUi={UI.accounts.startDate}
            />
            <TextInput
              label={t('ccItem.endDate')}
              type="date"
              value={endDate}
              onChange={(value) => {
                setEndDate(value);
                setError(undefined);
              }}
              dataUi={UI.accounts.endDate}
            />
          </div>
        ) : null}
        {showRepayment ? (
          <>
            <SelectInput
              label={t('accounts.repaymentAccount')}
              value={repaymentAccountId}
              onChange={setRepaymentAccountId}
              options={repaymentOptions}
              hint={t('accounts.repaymentHint')}
              dataUi={UI.accounts.repaymentAccount}
            />
            <SelectInput
              label={t('accounts.repaymentDay')}
              value={repaymentDayText}
              onChange={setRepaymentDayText}
              options={repaymentDayOptions}
              dataUi={UI.accounts.repaymentDay}
            />
          </>
        ) : null}
        {showReturn ? (
          <>
            {/* 小数と負号を入力するため inputMode は指定しない
                （numeric / decimal のソフトキーボードに '-' キーが無い）。符号付きの金額欄も同じ扱い。 */}
            <TextInput
              label={t('accounts.annualReturn')}
              value={annualReturnText}
              onChange={(v) => {
                setAnnualReturnText(v);
                setError(undefined);
              }}
              hint={t('accounts.annualReturnHint')}
              dataUi={UI.accounts.annualReturn}
            />
            <SelectInput
              label={t('accounts.projectionAccount')}
              value={projectionAccountId}
              onChange={(v) => {
                setProjectionAccountId(v);
                setError(undefined);
              }}
              options={projectionOptions}
              hint={
                projectionAccountArchived
                  ? t('accounts.projectionAccountArchivedHint')
                  : t('accounts.projectionAccountHint')
              }
              dataUi={UI.accounts.projectionAccount}
            />
          </>
        ) : null}
        {showOpening ? (
          <>
            <TextInput
              label={t('accounts.openingAmount')}
              inputMode={digits === 0 ? 'numeric' : 'decimal'}
              value={openingAmountText}
              onChange={(v) =>
                setOpeningAmountText(sanitizeAmountText(v, digits, openingAmountText))
              }
              hint={t('accounts.openingHint')}
              dataUi={UI.accounts.openingAmount}
            />
            {openingAmountText !== '' ? (
              <TextInput
                label={t('accounts.openingDate')}
                type="date"
                value={openingDate}
                onChange={setOpeningDate}
                dataUi={UI.accounts.openingDate}
              />
            ) : null}
          </>
        ) : null}
      </Modal>
      {archiveRename ? (
        <ConfirmDialog
          title={t('accounts.archiveRenameTitle')}
          body={t('accounts.archiveRenameBody', {
            name: archiveRename.name,
            renamed: archiveRename.renamed,
          })}
          confirmLabel={t('accounts.archiveRenameConfirm')}
          dataUi={UI.accounts.archiveRenameConfirm}
          onCancel={() => setArchiveRename(null)}
          onConfirm={async () => {
            setArchiveRename(null);
            await doSave(true);
          }}
        />
      ) : null}
      {discardConfirm}
    </>
  );
}
