/*
 * タグ画面。タグの作成/編集/アーカイブ/削除と、期間内の簡易集計。
 */
import { useMemo, useState } from 'react';
import { Modal } from '@snishi/foundation/ui/Modal';
import { useDirtyGuard } from '@snishi/foundation/ui/useDirtyGuard';
import { TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { useLedger } from '../../state/store';
import { aggregateEntryTags } from '../../domain/tags';
import { monthRange } from '../../domain/accounting';
import { currentYearMonth, nowIso } from '../../util/time';
import { newId } from '../../domain/ids';
import type { Tag } from '../../domain/types';
import { Money } from '../money';
import { errorText, t } from '../../i18n';
import { UI } from '../../ui-contract';

type Period = 'month' | 'year' | 'all';

export function Tags() {
  const { ledger, saveTag, removeTag } = useLedger();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Tag | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [period, setPeriod] = useState<Period>('month');

  const currency = ledger?.settings.currency ?? 'JPY';
  const tags = ledger?.tags ?? [];
  const visible = tags.filter((tg) => showArchived || !tg.archived);

  const { year, month } = currentYearMonth();
  const range = useMemo(() => {
    if (period === 'all') return undefined;
    if (period === 'year') return { from: `${year}-01-01`, to: `${year}-12-31` };
    return monthRange(year, month);
  }, [period, year, month]);

  const entryTotals = useMemo(
    () =>
      aggregateEntryTags(ledger?.journalEntries ?? [], ledger?.tags ?? [], range).filter(
        (x) => x.count > 0,
      ),
    [ledger, range],
  );

  async function toggleArchive(tag: Tag) {
    await saveTag({ ...tag, archived: !tag.archived, updatedAt: nowIso() }).catch(() => undefined);
  }

  return (
    <section aria-labelledby="tags-title" data-ui={UI.tags.view}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 className="screen-title" id="tags-title" style={{ marginBottom: 0 }}>
          {t('tags.title')}
        </h1>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setCreating(true)}
          data-ui={UI.tags.create}
        >
          <Icon name="add" size={18} />
          {t('tags.add')}
        </button>
      </div>
      <p className="field__hint" style={{ margin: 'var(--space-2) 0 var(--space-3)' }}>
        {t('tags.intro')}
      </p>

      <label
        style={{
          display: 'inline-flex',
          gap: 8,
          alignItems: 'center',
          marginBottom: 'var(--space-3)',
        }}
      >
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        {t('tags.showArchived')}
      </label>

      {visible.length === 0 ? (
        <div className="card card--pad empty">{t('tags.empty')}</div>
      ) : (
        <ul className="card list" data-ui={UI.tags.list}>
          {visible.map((tag) => (
            <li key={tag.id} className="list__item">
              <div className="list__main">
                <div className="list__title">
                  {tag.name}{' '}
                  {tag.archived ? (
                    <span className="tag tag--neutral">{t('tags.archived')}</span>
                  ) : null}
                </div>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setEditing(tag)}
                  aria-label={`${t('tags.edit')}: ${tag.name}`}
                >
                  <Icon name="edit" size={18} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => toggleArchive(tag)}
                  aria-label={`${tag.archived ? t('tags.unarchive') : t('tags.archive')}: ${tag.name}`}
                >
                  <Icon name={tag.archived ? 'restore' : 'archive'} size={18} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setPendingDelete(tag)}
                  aria-label={`${t('tags.delete')}: ${tag.name}`}
                >
                  <Icon name="delete" size={18} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 集計 */}
      <p className="section-label">{t('tags.summary')}</p>
      <div className="toolbar">
        <label className="sr-only" htmlFor="tags-period">
          {t('tags.period')}
        </label>
        <select
          id="tags-period"
          className="select"
          value={period}
          aria-label={t('tags.period')}
          onChange={(e) => setPeriod(e.target.value as Period)}
          data-ui={UI.tags.period}
        >
          <option value="month">{t('statements.thisMonth')}</option>
          <option value="year">{t('statements.thisYear')}</option>
          <option value="all">{t('statements.allPeriods')}</option>
        </select>
      </div>

      <p className="section-label">{t('tags.entryTags')}</p>
      {entryTotals.length === 0 ? (
        <div className="card card--pad muted">{t('tags.noTaggedData')}</div>
      ) : (
        <div className="card" data-ui={UI.tags.entrySummary}>
          {entryTotals.map((x) => (
            <div className="stmt-row" key={x.tag.id}>
              <span>
                {x.tag.name}{' '}
                <span className="muted" style={{ fontSize: 12 }}>
                  {t('tags.taggedCount', { count: x.count })}
                </span>
              </span>
              <span className="stmt-row__num">
                <Money amount={x.total} currency={currency} />
              </span>
            </div>
          ))}
        </div>
      )}

      {creating ? <TagSheet onClose={() => setCreating(false)} /> : null}
      {editing ? <TagSheet existing={editing} onClose={() => setEditing(null)} /> : null}
      {pendingDelete ? (
        <ConfirmDialog
          title={t('tags.deleteConfirmTitle')}
          body={t('tags.deleteConfirmBody', { name: pendingDelete.name })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            const tg = pendingDelete;
            setPendingDelete(null);
            await removeTag(tg.id).catch(() => undefined);
          }}
        />
      ) : null}
    </section>
  );
}

function TagSheet({ existing, onClose }: { existing?: Tag; onClose: () => void }) {
  const { saveTag } = useLedger();
  const [name, setName] = useState(existing?.name ?? '');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (name.trim() === '') {
      setError(t('tags.error.name'));
      return;
    }
    setSubmitting(true);
    const ts = nowIso();
    const tag: Tag = {
      id: existing?.id ?? newId(),
      name: name.trim(),
      scope: 'entry',
      archived: existing?.archived ?? false,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    try {
      await saveTag(tag);
      onClose();
    } catch (e) {
      setError(errorText(e, 'tags.error.save'));
      setSubmitting(false);
    }
  }

  const snapshot = JSON.stringify({ name });
  const [initialSnapshot] = useState(snapshot);
  const dirty = snapshot !== initialSnapshot;
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

  return (
    <>
      <Modal
        title={existing ? t('tags.edit') : t('tags.add')}
        onClose={requestClose}
        dismissMode="if-clean"
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={requestClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={submit}
              disabled={submitting}
              data-ui={UI.tags.save}
            >
              {t('common.save')}
            </button>
          </>
        }
      >
        <TextInput
          label={t('tags.name')}
          required
          value={name}
          placeholder={t('tags.namePlaceholder')}
          onChange={(v) => {
            setName(v);
            setError(undefined);
          }}
          error={error}
          dataUi={UI.tags.name}
        />
        <p className="field__hint">{t('tags.entryOnlyHint')}</p>
      </Modal>
      {discardConfirm}
    </>
  );
}
