/*
 * 月額化コスト。サブスク・年払い・耐久財・定期イベントを統一して「月あたりコスト」で見る。
 * 既定は active のみ表示。一時停止/終了はトグルで表示。これ自体は仕訳を生成しない登録簿。
 */
import { useMemo, useState } from 'react';
import { useLedger } from '../../state/store';
import { monthlyCostForMonth, representativeMonthlyAmount } from '../../domain/monthlyCost';
import { currentYearMonth, nowIso } from '../../util/time';
import { Money } from '../money';
import { Icon } from '../Icon';
import { ConfirmDialog } from '../ConfirmDialog';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { UI } from '../../ui-contract';
import type { MonthlyCostItem, MonthlyCostKind } from '../../domain/types';

function kindLabel(kind: MonthlyCostKind): string {
  return t(`monthlyCost.kind.${kind}` as MessageKey);
}

export function Allocations() {
  const { ledger, saveMonthlyCost, removeMonthlyCost } = useLedger();
  const [showInactive, setShowInactive] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MonthlyCostItem | null>(null);
  const { year, month } = currentYearMonth();
  const currentYm = `${year}-${String(month).padStart(2, '0')}`;
  const currency = ledger?.settings.currency ?? 'JPY';

  const accountsMap = useMemo(
    () => new Map((ledger?.accounts ?? []).map((a) => [a.id, a] as const)),
    [ledger],
  );
  const name = (id?: string): string => (id ? (accountsMap.get(id)?.name ?? '—') : '—');

  const items = useMemo(
    () => (ledger?.monthlyCostItems ?? []).filter((m) => showInactive || m.status === 'active'),
    [ledger, showInactive],
  );

  async function togglePause(item: MonthlyCostItem) {
    const next = item.status === 'active' ? 'paused' : 'active';
    await saveMonthlyCost({ ...item, status: next, updatedAt: nowIso() }).catch(() => undefined);
  }

  return (
    <section aria-labelledby="allocations-title" data-ui={UI.allocations.view}>
      <h1 className="screen-title" id="allocations-title">
        {t('monthlyCost.title')}
      </h1>

      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('monthlyCost.intro')}
      </p>

      <label
        style={{
          display: 'inline-flex',
          gap: 8,
          alignItems: 'center',
          margin: '0 0 var(--space-4)',
        }}
      >
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(e) => setShowInactive(e.target.checked)}
          data-ui={UI.allocations.showCompleted}
        />
        {t('monthlyCost.showInactive')}
      </label>

      {items.length === 0 ? (
        <div className="card card--pad empty">
          <Icon name="calendar" size={28} />
          <p style={{ marginTop: 'var(--space-3)' }}>{t('monthlyCost.empty')}</p>
        </div>
      ) : (
        <div className="stack" data-ui={UI.allocations.list}>
          {items.map((m) => {
            const thisMonth = monthlyCostForMonth(m, currentYm);
            return (
              <div className="card card--pad" key={m.id}>
                <div
                  className="list__title"
                  style={{
                    marginBottom: 'var(--space-2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <span>
                    {m.name}{' '}
                    <span className={`tag ${m.status === 'active' ? 'tag--teal' : 'tag--neutral'}`}>
                      {t(`monthlyCost.status.${m.status}` as MessageKey)}
                    </span>
                  </span>
                  <span className="row-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => togglePause(m)}
                      aria-label={`${m.status === 'active' ? t('monthlyCost.pause') : t('monthlyCost.resume')}: ${m.name}`}
                    >
                      <Icon name={m.status === 'active' ? 'archive' : 'restore'} size={18} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setPendingDelete(m)}
                      aria-label={`${t('common.delete')}: ${m.name}`}
                    >
                      <Icon name="trash" size={18} />
                    </button>
                  </span>
                </div>
                <div className="kv">
                  <span className="muted">{t('monthlyCost.kindLabel')}</span>
                  <span>{kindLabel(m.kind)}</span>
                </div>
                <div className="kv">
                  <span className="muted">{t('monthlyCost.amount')}</span>
                  <span>
                    <Money amount={m.amount} currency={currency} />
                  </span>
                </div>
                <div className="kv">
                  <span className="muted">{t('monthlyCost.monthly')}</span>
                  <span>
                    <Money amount={representativeMonthlyAmount(m)} currency={currency} />
                  </span>
                </div>
                <div className="kv">
                  <span className="muted">{t('monthlyCost.costMonths')}</span>
                  <span>{t('monthlyCost.monthsUnit', { count: m.costMonths })}</span>
                </div>
                {m.repeatEveryMonths !== undefined ? (
                  <div className="kv">
                    <span className="muted">{t('monthlyCost.repeat')}</span>
                    <span>{t('monthlyCost.repeatUnit', { count: m.repeatEveryMonths })}</span>
                  </div>
                ) : null}
                <div className="kv">
                  <span className="muted">{t('monthlyCost.thisMonth')}</span>
                  <span>
                    <Money amount={thisMonth} currency={currency} />
                  </span>
                </div>
                <div className="kv">
                  <span className="muted">{t('monthlyCost.expenseCategory')}</span>
                  <span>{name(m.expenseAccountId)}</span>
                </div>
                <div className="kv">
                  <span className="muted">{t('monthlyCost.payment')}</span>
                  <span>{name(m.paymentAccountId)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pendingDelete ? (
        <ConfirmDialog
          title={t('monthlyCost.deleteConfirmTitle')}
          body={t('monthlyCost.deleteConfirmBody', { name: pendingDelete.name })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            const m = pendingDelete;
            setPendingDelete(null);
            await removeMonthlyCost(m.id).catch(() => undefined);
          }}
        />
      ) : null}
    </section>
  );
}
