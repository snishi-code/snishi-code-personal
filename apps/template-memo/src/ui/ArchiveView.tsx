/*
 * アーカイブ一覧。ソフトデリート済みの対象を新しい順に表示し、
 * 「戻す」(restoreSubject) と「完全削除」(ConfirmDialog → purgeSubject) を提供する。
 * 完全削除は取り消し不可のため danger + 明示確認（dismissMode 既定 'never'）。
 */
import { useState } from 'react';
import { AppHeader } from '@snishi/foundation/ui/AppHeader';
import { Button } from '@snishi/foundation/ui/Button';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { EmptyState } from '@snishi/foundation/ui/EmptyState';
import { useToast } from '@snishi/foundation/ui/toast';
import { archivedSubjects, purgeSubject, restoreSubject } from '../data/store';
import type { Subject } from '../domain/types';
import { errorText, t } from '../i18n';
import { useStore } from './useStore';

export function ArchiveView({ onBack }: { onBack: () => void }) {
  const state = useStore();
  const toast = useToast();
  const [purgeTarget, setPurgeTarget] = useState<Subject | null>(null);

  const rows = archivedSubjects(state);

  const doRestore = (id: string) => {
    void restoreSubject(id).catch((e: unknown) =>
      toast.show(errorText(e, 'toast.saveFailed'), 'error'),
    );
  };

  const doPurge = () => {
    if (!purgeTarget) return;
    void purgeSubject(purgeTarget.id)
      .then(() => setPurgeTarget(null))
      .catch((e: unknown) => toast.show(errorText(e, 'toast.saveFailed'), 'error'));
  };

  return (
    <div className="tm-screen">
      <AppHeader
        left={
          <Button variant="ghost" onClick={onBack}>
            {t('detail.back')}
          </Button>
        }
        center={<h1 style={{ fontSize: '1rem', margin: 0 }}>{t('archive.title')}</h1>}
      />

      <main className="tm-main">
        {rows.length === 0 ? (
          <EmptyState message={t('archive.empty')} />
        ) : (
          rows.map((x) => (
            <div key={x.id} className="tm-subject-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{x.name || t('home.untitledSubject')}</div>
                <div className="tm-subject-meta">
                  {t('archive.archivedAt', {
                    date: new Date(x.archivedAt ?? 0).toLocaleDateString(),
                  })}
                </div>
              </div>
              <Button onClick={() => doRestore(x.id)}>{t('archive.restore')}</Button>
              <Button variant="danger" onClick={() => setPurgeTarget(x)}>
                {t('archive.purge')}
              </Button>
            </div>
          ))
        )}
      </main>

      {purgeTarget !== null ? (
        <ConfirmDialog
          title={t('archive.purgeConfirmTitle')}
          body={t('archive.purgeConfirmBody', {
            name: purgeTarget.name || t('home.untitledSubject'),
          })}
          confirmLabel={t('archive.purge')}
          cancelLabel={t('common.cancel')}
          danger
          onConfirm={doPurge}
          onCancel={() => setPurgeTarget(null)}
        />
      ) : null}
    </div>
  );
}
