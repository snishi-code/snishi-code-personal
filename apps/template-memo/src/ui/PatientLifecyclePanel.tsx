// 詳細画面下部の「患者管理」エリア (manager の正本管理・2026-07-17 患者フラット化)。
//
// 患者はフラットな patients store の 1 レコードで、作業状態は patientId に追従する。そのため
// 旧・patientMove (deep copy + 転棟マーカー) / Trash bundle 退避は不要になり、操作は縮んだ:
//   - 通常 place ビュー: [場所を移動] (place 属性の変更のみ) / [アーカイブ] (退院/終了・ソフトデリート)
//   - アーカイブビュー:   [戻す] (place を選んで復帰) / [完全削除] (全ユーザーの作業状態ごと)
// アーカイブの取り消しは「戻す」(第一級 UI) が担い、完全削除は確認 2 回の最終操作 (undo なし)。
// スナップショット (undo 網) は作業状態のクリア用で、master の復活には使わない。
// member には出さない (master 操作は manager のみ。呼び出し側 DetailView がゲートする)。

import { useState } from 'react';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { useToast } from '@snishi/foundation/ui/toast';
import type { Patient } from '../domain/types';
import type { AppRuntime } from './appRuntime';
import { MovePatientDialog } from './MovePatientDialog';
import { OverlayBinding } from './registries';
import { s } from '../i18n';
import { UI } from '../ui-contract';

interface PendingAction {
  confirmBody: string;
  confirmLabel: string;
  run: () => Promise<void>;
}

export function PatientLifecyclePanel({
  runtime,
  patient,
  onDone,
}: {
  runtime: AppRuntime;
  patient: Patient;
  /** 操作の成功後 (= この患者が現ビューから消えた後) に呼ぶ。ホームへ戻す等 */
  onDone: () => void;
}) {
  const toast = useToast();
  const { store } = runtime;
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [moveOpen, setMoveOpen] = useState<'move' | 'restore' | null>(null);
  const [busy, setBusy] = useState(false);

  const archiveView = store.isArchiveViewActive();

  async function exec(action: PendingAction): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await action.run();
      runtime.bump();
      onDone();
    } catch (e) {
      console.error('patient lifecycle action failed:', e);
      toast.show(s.patient.delete.failed, 'error');
      runtime.bump();
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const buttons: Array<{
    key: string;
    label: string;
    dataUi: string;
    danger?: boolean;
    onClick: () => void;
  }> = [];
  if (archiveView) {
    buttons.push({
      key: 'restore',
      label: s.patient.restore.label,
      dataUi: UI.lifecycle.restore,
      onClick: () => setMoveOpen('restore'),
    });
    buttons.push({
      key: 'permanent',
      label: s.patient.delete.permanentBtn,
      dataUi: UI.lifecycle.permanentDelete,
      danger: true,
      onClick: () =>
        setPending({
          confirmBody: s.patient.delete.permanent.confirm,
          confirmLabel: s.common.delete,
          run: () => store.deletePatientPermanently(patient.pid),
        }),
    });
  } else {
    buttons.push({
      key: 'move',
      label: s.patient.move,
      dataUi: UI.patient.move,
      onClick: () => setMoveOpen('move'),
    });
    buttons.push({
      key: 'archive',
      label: s.patient.archive.label,
      dataUi: UI.lifecycle.archive,
      danger: true,
      onClick: () =>
        setPending({
          confirmBody: s.patient.archive.confirm,
          confirmLabel: s.patient.archive.label,
          run: () => store.archivePatient(patient.pid),
        }),
    });
  }

  return (
    <div className="lifecycleActions">
      {archiveView ? <p className="muted lifecycleNote">{s.archive.detailNote}</p> : null}
      <div className="section-label">{s.patient.lifecycle.actions.title}</div>
      <div className="lifecycleBtnRow">
        {buttons.map((b) => (
          <button
            key={b.key}
            type="button"
            className={`btn${b.danger ? ' btn--danger' : ''}`}
            disabled={busy}
            data-ui={b.dataUi}
            onClick={b.onClick}
          >
            {b.label}
          </button>
        ))}
      </div>

      {pending ? <OverlayBinding onClose={() => setPending(null)} /> : null}
      {pending ? (
        <ConfirmDialog
          title={s.patient.lifecycle.actions.title}
          body={pending.confirmBody}
          confirmLabel={pending.confirmLabel}
          cancelLabel={s.common.cancel}
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => void exec(pending)}
        />
      ) : null}

      {moveOpen ? (
        <MovePatientDialog
          mode={moveOpen}
          patient={patient}
          runtime={runtime}
          onClose={() => setMoveOpen(null)}
          onMoved={onDone}
        />
      ) : null}
    </div>
  );
}
