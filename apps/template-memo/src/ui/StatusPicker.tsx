// 共通ステータス選択 UI。
//
// StatusSwatchRow: 患者シート (PatientEditPopup) とホームのステータスポップアップの両方で
// 使う 5 色ボックス列 (NONE/YELLOW/GREEN/GRAY/BLUE)。PatientEditPopup L51-69 から抽出。
//
// StatusPickerPopup: ホームのステータスボタンからタップで開く軽量ポップアップ。
// foundation Popup (無題・中央) を土台にする。overlay 登録必須 (戻る操作で閉じるため)。

import { Popup } from '@snishi/foundation/ui/Popup';
import type { PatientStatus } from '../domain/types';
import { getStatusOptions, statusClass } from './patientDisplay';
import { useRegisterOverlay } from './registries';
import { s } from '../i18n';
import { UI } from '../ui-contract';

// ── StatusSwatchRow ──────────────────────────────────────────────────────────
// 5 色ボックスを横一列に並べる純 UI コンポーネント。
// aria-pressed / aria-label / data-ui は PatientEditPopup の現挙動を維持。

export function StatusSwatchRow({
  value,
  onSelect,
  dataUi,
}: {
  value: PatientStatus;
  onSelect: (status: PatientStatus) => void;
  dataUi?: string;
}) {
  return (
    <div className="statusPickerList">
      {getStatusOptions().map((opt) => (
        <button
          key={opt.status}
          type="button"
          className={`statusPickerBox ${statusClass(opt.status) || 'status-none'}${value === opt.status ? ' selected' : ''}`}
          aria-pressed={value === opt.status}
          aria-label={opt.label}
          title={opt.label}
          data-ui={dataUi ?? UI.patient.statusOption}
          onClick={() => onSelect(opt.status)}
        >
          <span aria-hidden="true">{opt.mark}</span>
        </button>
      ))}
    </div>
  );
}

// ── StatusPickerPopup ────────────────────────────────────────────────────────
// ホームのステータスボタンで開く軽量ポップアップ。選択後に onSelect → onClose。

export function StatusPickerPopup({
  value,
  onSelect,
  onClose,
  dataUi,
}: {
  value: PatientStatus;
  onSelect: (status: PatientStatus) => void;
  onClose: () => void;
  dataUi?: string;
}) {
  // overlay 登録 (戻る操作 / 画面遷移でポップアップだけ閉じる)
  useRegisterOverlay(onClose);

  function handleSelect(status: PatientStatus) {
    onSelect(status);
    onClose();
  }

  return (
    <Popup
      ariaLabel={s.home.statusPicker.aria}
      onClose={onClose}
      dataUi={dataUi ?? UI.patient.statusPopup}
    >
      <div className="statusPickerPopupBody">
        <div className="statusPickerHelp">
          <p className="statusPickerLegend">{s.home.statusPicker.legend}</p>
          <p>{s.home.statusPicker.note.green}</p>
          <p>{s.home.statusPicker.note.blue}</p>
          <p>{s.home.statusPicker.note.clear}</p>
        </div>
        <StatusSwatchRow value={value} onSelect={handleSelect} dataUi={UI.patient.statusOption} />
      </div>
    </Popup>
  );
}
