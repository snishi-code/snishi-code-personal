// 患者シート (ホーム患者カード追加直後 / 詳細の患者メタボタンから開く):
// ステータス (最上部 = 開いた指のすぐ近く) → 部屋番号 / 氏名 → タグ。
// ステータス変更は患者ボタンタップ直後に行う最頻操作なので、ボタン位置 (画面上部) から
// 指の移動距離が最小になる先頭に置く (ユーザー意図: 部屋番号付近の自然な位置)。
// 「キャンセル/保存ボタンなし・即時反映 (write-through)」。
// 可視タイトルは出さない (見れば分かる)。aria 上の名前は Modal の sr-only title で維持。

import { Modal } from '@snishi/foundation/ui/Modal';
import type { PatientStatus } from '../domain/types';
import type { AppRuntime } from './appRuntime';
import { sanitizeRoomInput } from './patientDisplay';
import { StatusSwatchRow } from './StatusPicker';
import { TagSelection } from './TagPicker';
import { s } from '../i18n';
import { UI } from '../ui-contract';
import { useRegisterOverlay } from './registries';

export function PatientEditPopup({
  patientNo,
  runtime,
  onClose,
}: {
  patientNo: number;
  runtime: AppRuntime;
  onClose: () => void;
}) {
  useRegisterOverlay(onClose);
  const { store } = runtime;
  const p = store.getAppState().patients[patientNo - 1];
  if (!p) return null;

  // アーカイブビューだけ編集をロックする (内容は表示)。
  const masterFieldLocked = store.isArchiveViewActive();
  // status / タグ。いつでも編集できる (スマホ主用途を止めない)。
  const canWork = true;

  function commit(mutate: () => void): void {
    mutate();
    store.markUpdated(patientNo); // notify → bump (再描画) + updatedAt
    store.scheduleSave();
  }

  return (
    <Modal
      title={s.patientSheet.title}
      titleVariant="sr-only"
      onClose={onClose}
      variant="dialog"
      dataUi={UI.patient.editPopup}
      closeLabel={s.common.close}
    >
      {/* ── 最上部: ステータス (色ボックス + 形マークのみ。色名テキストは出さない —
          aria/title で読める)。最頻操作なので指の移動距離が最小の先頭に置く。
          status は患者作業状態: manager / active set 未選択 member には出さない (Phase 1/4)。 ── */}
      {canWork ? (
        <div className="patientSheetField patientSheetStatusField">
          <span className="patientSheetFieldLabel">{s.patientSheet.status}</span>
          <StatusSwatchRow
            value={p.status}
            onSelect={(status) => commit(() => (p.status = status as PatientStatus))}
            dataUi={UI.patient.statusOption}
          />
        </div>
      ) : null}

      {/* ── 部屋番号 + 氏名 (頻繁に編集しないのでコンパクト横並び)。
          受信病棟の名簿管理患者は正本由来のため readOnly。 ── */}
      <div className="patientSheetInfoRow">
        <label className="patientSheetInfoCell patientSheetRoomCell">
          <span className="patientSheetInfoLabel">{s.patientSheet.room}</span>
          <input
            className="input"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="off"
            defaultValue={p.room}
            data-ui={UI.patient.room}
            readOnly={masterFieldLocked}
            disabled={masterFieldLocked}
            onInput={(e) => {
              if (masterFieldLocked) return;
              const el = e.target as HTMLInputElement;
              const cleaned = sanitizeRoomInput(el.value);
              if (cleaned !== el.value) el.value = cleaned;
              commit(() => (p.room = cleaned));
            }}
          />
        </label>
        <label className="patientSheetInfoCell patientSheetNameCell">
          <span className="patientSheetInfoLabel">{s.patientSheet.name}</span>
          <input
            className="input"
            type="text"
            autoComplete="off"
            defaultValue={p.name}
            data-ui={UI.patient.name}
            readOnly={masterFieldLocked}
            disabled={masterFieldLocked}
            onInput={(e) => {
              if (masterFieldLocked) return;
              const next = (e.target as HTMLInputElement).value;
              commit(() => (p.name = next));
            }}
          />
        </label>
      </div>
      {/* ── タグ (単一系統・色は表示/分類のみ)。 ── */}
      {canWork ? (
        <div className="patientSheetField patientSheetTagsField">
          <span className="patientSheetFieldLabel">{s.patientSheet.tags}</span>
          <TagSelection
            store={store}
            selected={Array.isArray(p.tags) ? p.tags : []}
            onChange={(next) => commit(() => (p.tags = next))}
          />
        </div>
      ) : null}
    </Modal>
  );
}
