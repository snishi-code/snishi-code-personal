/*
 * 初期残高の一括登録シート。
 *  - 初回起動時（完全に初期 seed 状態 + 未既読）に App が自動表示する。
 *  - 「設定 > 初期残高の一括登録」からいつでも再表示できる（状態機械を持たない再利用シート）。
 *  - 登録は opening の一括保存経路（createOpenings → repo.createOpenings）のみを使い、
 *    新しい永続化概念を増やさない。金額未入力の科目は何も作らない。
 */
import { useState } from 'react';
import { TextInput } from '@snishi/foundation/ui/Field';
import { Modal, useDirtyGuard } from './overlays';
import { sortAccounts } from '../domain/accountOrder';
import { useLedger } from '../state/store';
import { todayLocal } from '../util/time';
import { t } from '../i18n';
import { UI } from '../ui-contract';
import type { Account } from '../domain/types';
import type { OpeningInput } from '../data/repository';

// オンボーディングで残高を聞く対象（ユーザーが直接編集できる BS 科目のみ）。
// 継続コスト資産・取り置き・内部集約系は専用導線で作るため、ここには出さない。
const ASSET_ROLES: ReadonlySet<string> = new Set(['daily-asset', 'investment-asset']);
const LIABILITY_ROLES: ReadonlySet<string> = new Set(['payment-liability', 'other-liability']);

export function OnboardingSheet({ onClose }: { onClose: () => void }) {
  const { ledger, createOpenings } = useLedger();
  const accounts = sortAccounts(ledger?.accounts ?? []);
  const assetRows = accounts.filter((a) => !a.archived && ASSET_ROLES.has(a.role));
  const liabilityRows = accounts.filter((a) => !a.archived && LIABILITY_ROLES.has(a.role));
  const registeredAccountIds = new Set(
    (ledger?.journalEntries ?? [])
      .filter((entry) => entry.kind === 'opening')
      .flatMap((entry) => entry.lines.map((line) => line.accountId)),
  );

  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [date, setDate] = useState(todayLocal());
  const [submitting, setSubmitting] = useState(false);

  const filled = Object.entries(amounts).filter(
    ([accountId, v]) =>
      !registeredAccountIds.has(accountId) && v !== '' && Number.parseInt(v, 10) > 0,
  );
  // 何か入力してあれば閉じる前に確認する（'0' だけの入力も含めて保護する）。
  const dirty = Object.values(amounts).some((v) => v !== '');
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

  async function submit() {
    if (!filled.length || date === '' || submitting) return;
    setSubmitting(true);
    try {
      const inputs: OpeningInput[] = filled.map(([accountId, v]) => ({
        accountId,
        amount: Number.parseInt(v, 10),
        date,
      }));
      await createOpenings(inputs);
      onClose();
    } catch {
      setSubmitting(false);
    }
  }

  const setAmount = (id: string, v: string) =>
    setAmounts((prev) => ({ ...prev, [id]: v.replace(/[^\d]/g, '') }));

  const renderRows = (rows: Account[]) =>
    rows.map((a) =>
      registeredAccountIds.has(a.id) ? (
        <div key={a.id} className="kv" data-ui={UI.onboarding.registered}>
          <span>{a.name}</span>
          <span className="tag tag--neutral">{t('onboarding.registered')}</span>
        </div>
      ) : (
        <TextInput
          key={a.id}
          label={a.name}
          inputMode="numeric"
          value={amounts[a.id] ?? ''}
          onChange={(v) => setAmount(a.id, v)}
          placeholder={t('onboarding.amountPlaceholder')}
          dataUi={UI.onboarding.amount}
        />
      ),
    );

  return (
    <>
      <Modal
        title={t('onboarding.title')}
        onClose={requestClose}
        dismissMode="if-clean"
        dataUi={UI.onboarding.view}
        // 開いた直後にブラウザの初期フォーカスでシートが途中まで送られることがあるため、
        // マウント時に先頭（説明文と基準日）へ戻す。
        scrollKey={0}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={requestClose}
              data-ui={UI.onboarding.skip}
            >
              {t('onboarding.skip')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={submit}
              disabled={filled.length === 0 || date === '' || submitting}
              data-ui={UI.onboarding.save}
            >
              {t('onboarding.save')}
            </button>
          </>
        }
      >
        <div className="stack">
          <p className="field__hint">{t('onboarding.intro')}</p>
          <TextInput
            label={t('onboarding.dateLabel')}
            type="date"
            value={date}
            onChange={setDate}
            required
          />
          <p className="field__hint">{t('onboarding.dateHint')}</p>

          <p className="section-label">{t('onboarding.assetSection')}</p>
          {renderRows(assetRows)}

          {liabilityRows.length > 0 ? (
            <>
              <p className="section-label">{t('onboarding.liabilitySection')}</p>
              {renderRows(liabilityRows)}
            </>
          ) : null}

          <p className="field__hint">{t('onboarding.laterHint')}</p>
        </div>
      </Modal>
      {discardConfirm}
    </>
  );
}
