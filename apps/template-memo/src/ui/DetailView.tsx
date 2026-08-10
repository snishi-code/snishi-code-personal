// 詳細 (患者) ビュー:
//   - 患者ヘッダ: メタボタン (ステータス形マーク + 部屋 + 氏名) → 患者情報ポップアップ
//   - プロブレムリスト → 継続メモ → 入力フォーム → 今回メモ (常時開)
//     → 転記用QR ボタン → 患者管理
//   - 下部固定バーは [ホーム] のみ (患者固有の操作は画面内の日本語ボタンへ)
//   - 患者切替はホーム一覧経由のみ (画面内の切替操作は持たない。旧・横スワイプ切替は
//     無自覚な画面遷移で入力ミスを生むため削除した)
//
// メモは visitMemo / standingMemo の 2 欄に集約する (write-through 保存は MemoCards 側)。

import { useEffect, useRef, useState } from 'react';
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

/**
 * 誤タップガード: 詳細画面へ入った直後と対象切替直後は、新しい入力 (pointerdown / keydown) が
 * 来るまで正常チェックや入力シートを発火させない。ゴーストクリックは pointerdown を伴わないため
 * これで弾ける。keydown でも解錠するのは、キーボードのみの利用者 (Tab → Enter 即時発火の
 * a11y 経路) がポインタ無しでは永久に発火できなくなるのを防ぐため。
 */
export function useFreshTapGuard(pid: string | null) {
  const freshTapRef = useRef(false);
  useEffect(() => {
    freshTapRef.current = false;
    const onInput = () => {
      freshTapRef.current = true;
    };
    window.addEventListener('pointerdown', onInput);
    window.addEventListener('keydown', onInput);
    return () => {
      window.removeEventListener('pointerdown', onInput);
      window.removeEventListener('keydown', onInput);
    };
  }, []);

  // 詳細ビューは対象切替で再マウントされないため、前対象の pointerdown を持ち越さない。
  useEffect(() => {
    freshTapRef.current = false;
  }, [pid]);

  return freshTapRef;
}

export function DetailView({
  runtime,
  selectedNo,
  onNavigateHome,
}: {
  runtime: AppRuntime;
  /** 1-based 患者番号 */
  selectedNo: number;
  /** 削除/復元の成功後にホームへ戻す */
  onNavigateHome?: () => void;
}) {
  useRevision(runtime);
  const { store } = runtime;
  const appState = store.getAppState();
  const patient = appState.patients[selectedNo - 1] ?? null;
  const freshTapRef = useFreshTapGuard(patient?.pid ?? null);

  const [qrOpen, setQrOpen] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);

  if (!patient) return null;

  const label = formatPatientLabel(patient, String(selectedNo));

  return (
    <section aria-label={s.patientSheet.title} className="detailView">
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
          status/今回メモ/継続メモは使える (スマホ主用途を止めない)。入力フォームは
          テンプレートの場所が無ければ自ら非表示になるため、fieldset での一括ロックはしない。 */}
      <fieldset className="editLock">
        {/* 継続メモ → 今回メモ: プロブレムの後・患者管理の前。上から「継続情報を見て、今回分を書く」
              流れにする (継続メモ = 患者ごとの背景 / 今回メモ = 今回の入力・転記用QR の本文候補)。 */}
        <StandingMemoCard runtime={runtime} patient={patient} />

        {/* 入力フォーム (テンプレート投影の入力欄)。継続メモの後、今回メモの前に置く。
              プロブレム/継続メモ = ずっと参照する背景、入力フォーム/今回メモ = 今回入力する情報。 */}
        <ProjectionFormCard runtime={runtime} patient={patient} freshTapRef={freshTapRef} />

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

      {/* 下部固定の操作バー: [ホーム] のみ。誤タップの一因だった前/次 icon ボタンも
          横スワイプ切替も持たない (患者切替はホーム経由)。患者固有の QR / ステータス変更も
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
