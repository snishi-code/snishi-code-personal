/*
 * 按分台帳。按分中(active)の項目を既定表示し、完了(completed)はトグルで表示。
 * 完了済みは削除せず履歴として残し、既定一覧からは自動で外れる（完了は現在月から導出）。
 */
import { useMemo, useState } from 'react';
import { useLedger } from '../../state/store';
import {
  isCompleted,
  monthlyAmount,
  remainingMonths,
  unrecognizedBalance,
} from '../../domain/allocation';
import { currentYearMonth } from '../../util/time';
import { Money } from '../money';
import { Icon } from '../Icon';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

export function Allocations() {
  const { ledger } = useLedger();
  const [showCompleted, setShowCompleted] = useState(false);
  const { year, month } = currentYearMonth();
  const currentYm = `${year}-${String(month).padStart(2, '0')}`;
  const currency = ledger?.settings.currency ?? 'JPY';

  const accountsMap = useMemo(
    () => new Map((ledger?.accounts ?? []).map((a) => [a.id, a] as const)),
    [ledger],
  );
  const name = (id: string): string => accountsMap.get(id)?.name ?? '—';

  const items = useMemo(() => {
    return (ledger?.allocations ?? []).filter((a) => showCompleted || !isCompleted(a, currentYm));
  }, [ledger, showCompleted, currentYm]);

  return (
    <section aria-labelledby="allocations-title" data-ui={UI.allocations.view}>
      <h1 className="screen-title" id="allocations-title">
        {t('allocations.title')}
      </h1>

      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('allocations.recognitionNote')}
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
          checked={showCompleted}
          onChange={(e) => setShowCompleted(e.target.checked)}
          data-ui={UI.allocations.showCompleted}
        />
        {t('allocations.showCompleted')}
      </label>

      {items.length === 0 ? (
        <div className="card card--pad empty">
          <Icon name="calendar" size={28} />
          <p style={{ marginTop: 'var(--space-3)' }}>{t('allocations.empty')}</p>
        </div>
      ) : (
        <div className="stack" data-ui={UI.allocations.list}>
          {items.map((a) => {
            const completed = isCompleted(a, currentYm);
            const remaining = remainingMonths(a, currentYm);
            return (
              <div className="card card--pad" key={a.id}>
                <div className="list__title" style={{ marginBottom: 'var(--space-2)' }}>
                  {a.name}{' '}
                  <span className={`tag ${completed ? 'tag--neutral' : 'tag--teal'}`}>
                    {completed ? t('allocations.statusCompleted') : t('allocations.statusActive')}
                  </span>
                </div>
                <div className="kv">
                  <span className="muted">{t('allocations.total')}</span>
                  <span>
                    <Money amount={a.totalAmount} currency={currency} />
                  </span>
                </div>
                <div className="kv">
                  <span className="muted">{t('allocations.months')}</span>
                  <span>{t('allocations.monthsUnit', { count: a.months })}</span>
                </div>
                <div className="kv">
                  <span className="muted">{t('allocations.monthly')}</span>
                  <span>
                    <Money amount={monthlyAmount(a)} currency={currency} />
                  </span>
                </div>
                <div className="kv">
                  <span className="muted">
                    {t('allocations.remainingMonths', { count: remaining })}
                  </span>
                  <span>
                    <Money amount={unrecognizedBalance(a, currentYm)} currency={currency} />
                    <span className="muted" style={{ fontSize: 12 }}>
                      {' '}
                      / {t('allocations.unrecognized')}
                    </span>
                  </span>
                </div>
                <div className="kv">
                  <span className="muted">{t('allocations.expenseCategory')}</span>
                  <span>{name(a.expenseAccountId)}</span>
                </div>
                <div className="kv">
                  <span className="muted">{t('allocations.payment')}</span>
                  <span>{name(a.paymentAccountId)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
