// 患者の移動先 place ピッカー (2026-07-17 患者フラット化)。
// 移動 = 患者レコードの placeId 属性を変えるだけ (作業状態は patientId に追従・コピーも複製もしない)。
// mode='restore' はアーカイブからの復帰 (place を選んで戻す)。失敗は toast で可視化して中断。

import { useState } from 'react';
import { Modal } from '@snishi/foundation/ui/Modal';
import { useToast } from '@snishi/foundation/ui/toast';
import type { AppRuntime } from './appRuntime';
import type { Patient } from '../domain/types';
import { s } from '../i18n';
import { UI } from '../ui-contract';
import { useRegisterOverlay } from './registries';

export function MovePatientDialog({
  mode,
  patient,
  runtime,
  onClose,
  onMoved,
}: {
  /** move = place 間の移動 / restore = アーカイブからの復帰 (place を選ぶ) */
  mode: 'move' | 'restore';
  patient: Patient;
  runtime: AppRuntime;
  onClose: () => void;
  onMoved?: () => void;
}) {
  useRegisterOverlay(onClose);
  const toast = useToast();
  const { store } = runtime;
  const [busy, setBusy] = useState(false);

  const activeId = store.storage.getActiveWorkspaceId();
  // move では現在の place を除外 (同一 place への移動は無意味)。restore は全 place が候補。
  const candidates = store.listPlaces().filter((p) => mode === 'restore' || p.placeId !== activeId);

  async function run(placeId: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (mode === 'restore') {
        await store.restorePatient(patient.pid, placeId);
      } else {
        await store.movePatientToPlace(patient.pid, placeId);
      }
      runtime.bump();
      onClose();
      onMoved?.();
    } catch (e) {
      console.error('patient move failed:', e);
      toast.show(mode === 'restore' ? s.patient.restore.failed : s.move.failed, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={mode === 'restore' ? s.patient.restore.title : s.move.title}
      onClose={onClose}
      variant="dialog"
      dataUi={UI.lifecycle.restoreDialog}
      closeLabel={s.common.close}
    >
      <div className="menu-list">
        {candidates.length === 0 ? <p className="muted">{s.move.list.empty}</p> : null}
        {candidates.map((place) => (
          <button
            key={place.placeId}
            type="button"
            className="menu-item"
            disabled={busy}
            data-ui={UI.lifecycle.moveDest}
            onClick={() => void run(place.placeId)}
          >
            {place.name}
          </button>
        ))}
      </div>
    </Modal>
  );
}
