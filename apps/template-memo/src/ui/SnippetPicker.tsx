/*
 * 定型文チップ列。タップでセクション本文へワンタップ挿入する
 * （旧 hospital-workspace/rounds の SnippetInsertRow のシートを、チップ直列へ簡略化）。
 * 空欄付き定型文（例 採血: WBC __ / CRP __）は挿入後に数字だけ埋める運用。
 */
import { useToast } from '@snishi/foundation/ui/toast';
import type { Snippet } from '../domain/types';
import { t } from '../i18n';

export function SnippetPicker({
  snippets,
  onInsert,
}: {
  snippets: Snippet[];
  /** 挿入本文（追記位置は親が決める）。 */
  onInsert: (body: string) => void;
}) {
  const toast = useToast();
  if (snippets.length === 0) return null;
  return (
    <div className="tm-chip-row" role="group" aria-label={t('detail.snippets')}>
      {snippets.map((sn) => (
        <button
          key={sn.id}
          type="button"
          className="tm-chip"
          onClick={() => {
            onInsert(sn.body);
            toast.show(t('detail.snippetInserted', { label: sn.label }), 'success');
          }}
        >
          {sn.label}
        </button>
      ))}
    </div>
  );
}
