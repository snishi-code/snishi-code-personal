// 定型文の挿入 (今回メモの下の「定型文」ボタン + 選択シート)。
//
// 定型文 (RoundsConfig.textSnippets) は「今回メモに展開するテキスト部品」。検査所見などは
// 空欄付き本文 (例: 採血: WBC __ / CRP __) で登録し、挿入後に数字だけ埋める運用。
// シートは挿入後も開いたまま (連続挿入可)。挿入は MemoCards の write-through と同じ経路
// (live patient へ書いて markUpdated + scheduleSave)。

import { useState } from 'react';
import { Modal } from '@snishi/foundation/ui/Modal';
import { Button } from '@snishi/foundation/ui/Button';
import { useToast } from '@snishi/foundation/ui/toast';
import type { Patient, Snippet } from '../domain/types';
import { appendSnippetToMemo } from '../domain/snippets';
import type { AppRuntime } from './appRuntime';
import { s } from '../i18n';
import { UI } from '../ui-contract';

export function SnippetInsertRow({
  runtime,
  patient,
  onInserted,
}: {
  runtime: AppRuntime;
  patient: Patient;
  /** 挿入成功のたびに呼ぶ (DetailView が今回メモ欄を開くのに使う)。 */
  onInserted?: () => void;
}) {
  const { store } = runtime;
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const snippets = store.getSettings().snippets;
  const pid = patient.pid;

  function insert(sn: Snippet): void {
    const p = store.getAppState().patients.find((x) => x.pid === pid);
    if (!p) return;
    p.visitMemo = appendSnippetToMemo(p.visitMemo, sn.body);
    // 今回メモの直接編集 (MemoCards) と同じ: 軽量群 revision を進めて保存予約。
    const no = store.getAppState().patients.findIndex((x) => x.pid === pid) + 1;
    store.markUpdated(no, { bumpLight: true });
    store.scheduleSave();
    toast.show(s.snippet.inserted(sn.label), 'success');
    onInserted?.();
  }

  return (
    <>
      <div className="btnRow detailSnippetRow">
        <Button dataUi={UI.detail.snippetBtn} onClick={() => setOpen(true)}>
          {s.snippet.btn}
        </Button>
      </div>
      {open ? (
        <Modal
          title={s.snippet.dialogTitle}
          onClose={() => setOpen(false)}
          variant="dialog"
          closeLabel={s.common.close}
          dataUi={UI.detail.snippetDialog}
        >
          {snippets.length === 0 ? (
            <p className="muted">{s.snippet.empty}</p>
          ) : (
            <div className="snippetList">
              {snippets.map((sn) => (
                <button
                  key={sn.id}
                  type="button"
                  className="menu-item snippetItemBtn"
                  data-ui={UI.detail.snippetItem}
                  onClick={() => insert(sn)}
                >
                  <span className="snippetItemLabel">{sn.label}</span>
                  {sn.body.trim() ? (
                    <span className="muted snippetItemPreview">{sn.body.split('\n')[0]}</span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </Modal>
      ) : null}
    </>
  );
}
