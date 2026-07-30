// 詳細 (患者) ビュー:
//   - 患者ヘッダ: メタボタン (ステータス形マーク + 部屋 + 氏名) → 患者情報ポップアップ
//   - プロブレムリスト → 継続メモ → 入力フォーム → 今回メモ (常時開)
//     → 転記用QR ボタン → 患者管理
//   - 下部固定バーは [ホーム] のみ (患者固有の操作は画面内の日本語ボタンへ)
//   - 患者切替は横スワイプ (補助操作)。前/次ボタンは持たない。
//
// メモは visitMemo / standingMemo の 2 欄に集約する (write-through 保存は MemoCards 側)。

import { useRef, useState } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { Icon } from '@snishi/foundation/ui/Icon';
import { BottomActionBar } from './BottomActionBar';
import { STATUS } from '../domain/types';
import { useRevision, type AppRuntime } from './appRuntime';
import { formatPatientLabel, statusClass, STATUS_MARK } from './patientDisplay';
import { ProblemListCard } from './ProblemListCard';
import { ProjectionFormCard } from './ProjectionFormCard';
import { VisitMemoCard, StandingMemoCard } from './MemoCards';
import { DetailQrDialog } from './DetailQrDialog';
import { PatientEditPopup } from './PatientEditPopup';
import { PatientLifecyclePanel } from './PatientLifecyclePanel';
import { s } from '../i18n';
import { UI } from '../ui-contract';

export function DetailView({
  runtime,
  selectedNo,
  onSelectNo,
  onNavigateHome,
}: {
  runtime: AppRuntime;
  /** 1-based 患者番号 */
  selectedNo: number;
  onSelectNo: (no: number) => void;
  /** 削除/復元の成功後にホームへ戻す */
  onNavigateHome?: () => void;
}) {
  useRevision(runtime);
  const { store } = runtime;
  const appState = store.getAppState();
  const patient = appState.patients[selectedNo - 1] ?? null;

  const [qrOpen, setQrOpen] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  // 横スワイプ開始座標 (hook なので early return より前で確保する)。
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

  if (!patient) return null;

  const label = formatPatientLabel(patient, String(selectedNo));

  // 横スワイプで患者切替 (前/次ボタンの代替・補助操作)。
  //   - 入力中の誤爆を避けるため、開始点が input/textarea/select/button/a/contenteditable の内部なら無視する。
  //   - 横移動が主 (|dx| >= 70 かつ |dx| > |dy| * 1.5) のときだけ発火する (縦スクロールと分離)。
  //   - 左スワイプ = 次患者 / 右スワイプ = 前患者。範囲外 (先頭で右 / 末尾で左) へは移動しない。
  // touch のみ (mouse/pointer drag は対象外)。移動は onSelectNo に委ね、scroll リセットは呼び出し元が行う。
  const total = appState.patients.length;

  function onTouchStart(e: React.TouchEvent<HTMLElement>): void {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, button, a, [contenteditable="true"]')) {
      swipeStartRef.current = null; // 入力/操作要素上の開始は患者切替にしない
      return;
    }
    const touch = e.touches[0];
    swipeStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  function onTouchEnd(e: React.TouchEvent<HTMLElement>): void {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start) return;
    const touch = e.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 70) return; // 横移動が小さい
    if (Math.abs(dx) <= Math.abs(dy) * 1.5) return; // 縦寄り (スクロール) は無視
    if (dx < 0) {
      if (selectedNo < total) onSelectNo(selectedNo + 1); // 左スワイプ = 次患者
    } else {
      if (selectedNo > 1) onSelectNo(selectedNo - 1); // 右スワイプ = 前患者
    }
  }

  return (
    <section
      aria-label={s.patientSheet.title}
      className="detailView"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* 上部 = 患者名・病室の表示 (タップで患者情報編集)。操作系は下部固定バー / 画面内ボタンへ。 */}
      <div className="viewToolbar detailToolbar">
        {/* 患者名ボタンのみ。タップで患者情報ポップアップ (氏名/部屋/ステータス/タグ編集を含む)。 */}
        <button
          type="button"
          className={`patientBtn detailMetaBtn ${statusClass(patient.status)}`}
          aria-label={s.patientSheet.editAria(label)}
          data-ui={UI.detail.meta}
          onClick={() => setMetaOpen(true)}
        >
          {patient.status !== STATUS.NONE ? (
            <span className="patientBtnMark" aria-hidden="true">
              {STATUS_MARK[patient.status]}
            </span>
          ) : null}
          <span className="detailMetaLabel">{label}</span>
          {/* タグのチップはヘッダーに出さない (スマホで患者名が潰れるため)。最重要情報 = 部屋番号 +
              患者名。タグ類は患者シート (このボタンで開く) に集約する。 */}
          <Icon name="edit" size={15} className="detailMetaEditIcon" />
        </button>
      </div>

      {/* プロブレムリスト (患者ごとの独立データ。転記用QR の先頭 = QR 順と一致) */}
      <ProblemListCard runtime={runtime} patient={patient} />

      {/* 患者作業状態 (継続メモ/入力フォーム/今回メモ)。テンプレート未選択でも
          status/今回メモ/継続メモは使える (スマホ主用途を止めない)。入力フォーム
          (ProjectionFormCard) は群が無ければ自ら非表示になるため、fieldset での一括ロックはしない。 */}
      <fieldset className="editLock">
        {/* 継続メモ → 今回メモ: プロブレムの後・患者管理の前。上から「継続情報を見て、今回分を書く」
              流れにする (継続メモ = 患者ごとの背景 / 今回メモ = 今回の入力・転記用QR の本文候補)。 */}
        <StandingMemoCard runtime={runtime} patient={patient} />

        {/* 入力フォーム (テンプレート投影の入力欄)。継続メモの後、今回メモの前に置く。
              プロブレム/継続メモ = ずっと参照する背景、入力フォーム/今回メモ = 今回入力する情報。 */}
        <ProjectionFormCard runtime={runtime} patient={patient} />

        {/* 今回メモは継続メモと同じく常時表示。患者切替時の key remount は維持する。 */}
        <VisitMemoCard key={`visit:${patient.pid}`} runtime={runtime} patient={patient} />
      </fieldset>

      {/* 患者固有の操作は画面内の日本語ボタンへ (下部バーは共通の [ホーム] に寄せる)。 */}
      <div className="card card--pad detailEmrQrRow">
        <Button dataUi={UI.detail.emrQr} onClick={() => setQrOpen(true)}>
          {s.detail.emrQr.btn}
        </Button>
      </div>

      {/* 患者管理 (place移動/アーカイブ/復帰/完全削除)。 */}
      <PatientLifecyclePanel
        runtime={runtime}
        patient={patient}
        onDone={() => {
          if (onNavigateHome) onNavigateHome();
        }}
      />

      {/* 下部固定の操作バー: [ホーム] のみ。患者切替は横スワイプ (補助操作) へ寄せ、
          誤タップの一因だった前/次 icon ボタンは持たない。患者固有の QR / ステータス変更も
          下部バーに置かない (画面内ボタン / ポップアップへ)。 */}
      <BottomActionBar
        className="detailActionBar"
        dataUi={UI.detail.actionBar}
        home={{
          label: s.detail.home.aria,
          dataUi: UI.detail.home,
          onClick: () => onNavigateHome?.(),
        }}
      />

      {qrOpen ? (
        <DetailQrDialog
          patient={patient}
          template={store.getActiveTemplate()}
          settings={store.getSettings()}
          onClose={() => setQrOpen(false)}
        />
      ) : null}
      {metaOpen ? (
        <PatientEditPopup
          patientNo={selectedNo}
          runtime={runtime}
          onClose={() => setMetaOpen(false)}
        />
      ) : null}
    </section>
  );
}
