// プロブレムリスト (患者ごとの独立データ) の編集 UI。
//
// 仕様:
//   - デフォルトで空の `#1` 入力欄を 1 つ表示する。番号は配列順から自動付与。
//   - 入力欄は textarea (改行可) で、内容に応じて縦に伸びる。
//   - 下部の追加ボタンで末尾に空行を増やす。
//   - 行削除: 空なら確認なし / 入力ありは確認ポップアップ。全行削除後は空 `#1` が残る
//     (= problems を空配列にして表示側で 1 行補う)。削除後は配列順で再採番される。
//   - フォーマット/設定とは無関係 (settings.formats には混ぜない)。設定画面からの一括編集や
//     専用一覧ページは作らない (患者ページ内のみ)。
//   - 患者は pid で捕捉する (前後ナビ・並び替えで別患者へ書かないため)。
//
// 書き込みは write-through (markUpdated + scheduleSave)。

import { useRef, useState } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import type { Patient } from '../domain/types';
import { readProblems } from '../domain/problems';
import type { AppRuntime } from './appRuntime';
import { OverlayBinding } from './registries';
import { hapticTick } from './feedback';
import { s } from '../i18n';
import { UI } from '../ui-contract';

/** 内容に応じて textarea を縦に伸ばす (field-sizing 未対応ブラウザ向けの JS フォールバック)。 */
function autosize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function ProblemListEditor({
  runtime,
  pid,
  readOnly = false,
}: {
  runtime: AppRuntime;
  pid: string;
  /** 管理受信患者では正本端末が管理するため編集不可 (内容は表示する)。 */
  readOnly?: boolean;
}) {
  const { store } = runtime;
  const [deleteIdx, setDeleteIdx] = useState<number | null>(null);
  const editSessionRef = useRef<{ pid: string; orig: string[]; captured: boolean } | null>(null);

  const live = () => store.getAppState().patients.find((x) => x.pid === pid) ?? null;
  // markUpdated は 1-based の患者番号を取る (store: patients[no - 1])。
  const liveNo = () => store.getAppState().patients.findIndex((x) => x.pid === pid) + 1;

  const patient = live();
  if (!patient) return null;

  const problems = readProblems(patient);
  // 表示行: 0 行でも空の #1 入力欄を必ず出す (保存値は空配列のまま)
  const rows = problems.length ? problems : [''];

  function writeRow(i: number, value: string): void {
    if (readOnly) return; // 管理受信患者は編集不可 (textarea も readOnly だが二重に防ぐ)
    const p = live();
    if (!p) return;
    const arr = readProblems(p);
    while (arr.length <= i) arr.push('');
    const session = editSessionRef.current;
    if (session && session.pid === pid && !session.captured && value !== (session.orig[i] ?? '')) {
      session.captured = true;
    }
    arr[i] = value;
    p.problems = arr;
    store.markUpdated(liveNo());
    store.scheduleSave();
  }

  function addRow(): void {
    const p = live();
    if (!p) return;
    const arr = readProblems(p);
    // 0 行のときに見えている仮想 #1 行を実体化してから #2 を足す (見た目と番号を一致させる)
    if (!arr.length) arr.push('');
    arr.push('');
    p.problems = arr;
    store.markUpdated(liveNo());
    store.scheduleSave();
    runtime.bump();
  }

  function deleteRow(i: number): void {
    const p = live();
    if (!p) return;
    const arr = readProblems(p);
    if (i >= arr.length) {
      // 仮想行 (保存値なし) の削除は何もしない
      setDeleteIdx(null);
      return;
    }
    arr.splice(i, 1); // 下の行が詰まり、表示番号は自動で再採番される
    p.problems = arr;
    store.markUpdated(liveNo());
    store.scheduleSave();
    hapticTick();
    runtime.bump();
  }

  function requestDelete(i: number): void {
    const text = String(rows[i] ?? '').trim();
    if (!text) {
      deleteRow(i); // 空行は確認なしで削除
      return;
    }
    setDeleteIdx(i);
  }

  // 上/下へ並び替え。pid で live patient を引き直し、別患者へ書かない。番号は配列順から再採番。
  function moveRow(i: number, dir: 'up' | 'down'): void {
    const p = live();
    if (!p) return;
    const arr = readProblems(p);
    const j = dir === 'up' ? i - 1 : i + 1;
    // 範囲外 (先頭の上 / 末尾の下 / 仮想 #1 行) は no-op
    if (i < 0 || j < 0 || i >= arr.length || j >= arr.length) return;
    const a = arr[i] ?? '';
    const b = arr[j] ?? '';
    arr[i] = b;
    arr[j] = a;
    p.problems = arr;
    store.markUpdated(liveNo());
    store.scheduleSave();
    hapticTick();
    runtime.bump();
  }

  return (
    <div className="problemList" data-ui={UI.problem.list}>
      {rows.map((text, i) => (
        <div key={i} className="problemRow" data-ui={UI.problem.row}>
          <span className="problemRowNo" aria-hidden="true">{`#${i + 1}`}</span>
          <textarea
            className="textarea problemRowInput"
            rows={1}
            // read-only 行は focus/change が来ないため autosize が走らない。field-sizing 非対応
            // ブラウザでも複数行プロブレムが切れないよう mount 時に一度伸ばす (内容は見える)。
            ref={(el) => {
              if (el && readOnly) autosize(el);
            }}
            value={text}
            readOnly={readOnly}
            placeholder={readOnly ? '' : s.problem.placeholder}
            aria-label={s.problem.input.aria(i + 1)}
            data-ui={UI.problem.input}
            onFocus={(e) => {
              if (readOnly) return;
              const p = live();
              editSessionRef.current = p ? { pid, orig: readProblems(p), captured: false } : null;
              autosize(e.currentTarget);
            }}
            onChange={(e) => {
              writeRow(i, e.target.value);
              autosize(e.currentTarget);
            }}
          />
          {/* 編集系ボタン (並び替え / 削除) は read-only では出さない (内容は見える)。 */}
          {!readOnly ? (
            <>
              <div className="problemRowMove">
                <IconButton
                  label={s.problem.move.up.aria(i + 1)}
                  dataUi={UI.problem.moveUp}
                  className="problemMoveBtn"
                  disabled={i === 0}
                  onClick={() => moveRow(i, 'up')}
                >
                  <Icon name="chevronRight" size={14} className="iconRotateUp" />
                </IconButton>
                <IconButton
                  label={s.problem.move.down.aria(i + 1)}
                  dataUi={UI.problem.moveDown}
                  className="problemMoveBtn"
                  disabled={i === rows.length - 1}
                  onClick={() => moveRow(i, 'down')}
                >
                  <Icon name="chevronRight" size={14} className="iconRotateDown" />
                </IconButton>
              </div>
              <IconButton
                label={s.problem.delete.aria(i + 1)}
                dataUi={UI.problem.delete}
                onClick={() => requestDelete(i)}
              >
                <Icon name="close" size={16} />
              </IconButton>
            </>
          ) : null}
        </div>
      ))}
      {readOnly ? (
        // アーカイブビュー: 読み取り専用 (復帰してから編集する)。
        <p className="muted problemReadonlyNote">{s.problem.readonly.note}</p>
      ) : (
        <button type="button" className="problemAddBtn" data-ui={UI.problem.add} onClick={addRow}>
          <Icon name="add" size={16} />
          <span>{s.problem.add}</span>
        </button>
      )}

      {deleteIdx != null ? <OverlayBinding onClose={() => setDeleteIdx(null)} /> : null}
      {deleteIdx != null ? (
        <ConfirmDialog
          title={s.common.delete}
          body={s.problem.delete.confirm(String(rows[deleteIdx] ?? '').trim())}
          confirmLabel={s.common.delete}
          cancelLabel={s.common.cancel}
          danger
          onCancel={() => setDeleteIdx(null)}
          onConfirm={() => {
            const idx = deleteIdx;
            setDeleteIdx(null);
            if (idx != null) deleteRow(idx);
          }}
        />
      ) : null}
    </div>
  );
}

/** 患者詳細のプロブレムリストカード (パネルカードと同じ枠で ProblemListEditor を包む)。 */
export function ProblemListCard({ runtime, patient }: { runtime: AppRuntime; patient: Patient }) {
  // アーカイブビューだけ read-only (内容は表示)。
  const readOnly = runtime.store.isArchiveViewActive();
  return (
    <section
      className="card panelCard problemCard"
      aria-label={s.panel.problem}
      data-ui={UI.problem.card}
    >
      <div className="panelCardHead">
        <div className="panelLabel">{s.panel.problem}</div>
      </div>
      <ProblemListEditor runtime={runtime} pid={patient.pid} readOnly={readOnly} />
    </section>
  );
}
