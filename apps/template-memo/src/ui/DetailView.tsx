// 詳細 (患者) ビュー:
//   - 患者ヘッダ: メタボタン (ステータス形マーク + 部屋 + 氏名) → 患者情報ポップアップ
//   - ヘッダー直下: タグ行 (色 = ラウンド開始で外れるか。タップでその場で付け外し)
//   - プロブレムリスト → 継続メモ → 入力フォーム → 転記用QR ボタン → 患者管理
//   - 下部固定バーは [ホーム] のみ (患者固有の操作は画面内の日本語ボタンへ)
//   - 患者切替はホーム一覧経由のみ (画面内の切替操作は持たない。旧・横スワイプ切替は
//     無自覚な画面遷移で入力ミスを生むため削除した)
//
// 今回分の自由本文は入力フォーム (ProjectionFormCard) の各場所が持つ。この画面が持つ独立メモは
// 継続メモ (standingMemo) だけ (write-through 保存は MemoCards 側)。

import { useEffect, useRef, useState } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { Icon } from '@snishi/foundation/ui/Icon';
import { BottomActionBar } from './BottomActionBar';
import { STATUS } from '../domain/types';
import { useRevision, type AppRuntime } from './appRuntime';
import { formatPatientLabel, statusClass, STATUS_MARK } from './patientDisplay';
import { ProblemListCard } from './ProblemListCard';
import { ProjectionFormCard } from './ProjectionFormCard';
import { StandingMemoCard } from './MemoCards';
import { DetailQrDialog } from './DetailQrDialog';
import { PatientEditPopup } from './PatientEditPopup';
import { PatientLifecyclePanel } from './PatientLifecyclePanel';
import { TagSelection } from './TagPicker';
import { getAllTags } from './tags';
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
  // タグ行はタグ定義がある時だけ出す (未使用なら空行を作らない)。
  const tagNames = getAllTags(store.getSettings());

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
          {/* タグのチップはこのボタンの中には入れない (ボタンの入れ子は不正・患者名も潰れる)。
              タグはヘッダー直下の独立した行に置く (下記)。 */}
          <Icon name="edit" size={15} className="detailMetaEditIcon" />
        </button>
      </div>

      {/* タグ (色 = ラウンド開始で外れるか)。表示だけでなくその場で付け外しできる。
          新規タグの作成は対象シート / 設定に集約する (allowAdd=false)。
          タグ定義が 1 つも無いときは行ごと出さない (使っていない人に空行を作らない)。 */}
      {tagNames.length > 0 ? (
        <div
          className="detailTagsRow"
          role="group"
          aria-label={s.patientSheet.tags}
          data-ui={UI.detail.tags}
        >
          <TagSelection
            store={store}
            selected={Array.isArray(patient.tags) ? patient.tags : []}
            onChange={(next) => {
              // 書き込み対象は描画時に読んだ患者ではなく、その時点の live を引き直す
              // (write-through 保存。PatientEditPopup と同じ流儀)。
              const target = store.getAppState().patients[selectedNo - 1];
              if (!target) return;
              target.tags = next;
              store.markUpdated(selectedNo); // notify → bump (再描画) + updatedAt
              store.scheduleSave();
            }}
            allowAdd={false}
          />
        </div>
      ) : null}

      {/* プロブレムリスト (患者ごとの独立データ。転記用QR の先頭 = QR 順と一致) */}
      <ProblemListCard runtime={runtime} patient={patient} />

      {/* 患者作業状態 (継続メモ/入力フォーム)。テンプレート未選択でも status/継続メモは使える
          (スマホ主用途を止めない)。入力フォームはテンプレートの場所が無ければ自ら非表示になるため、
          fieldset での一括ロックはしない。 */}
      <fieldset className="editLock">
        {/* 継続メモ → 入力フォーム: プロブレムの後・患者管理の前。上から「継続情報を見て、今回分を
              書く」流れにする (継続メモ = 患者ごとの背景 / 入力フォーム = 今回分の入力)。 */}
        <StandingMemoCard runtime={runtime} patient={patient} />

        {/* 入力フォーム (テンプレート投影の入力欄 + 場所ごとの自由入力欄)。今回分はここへ書く。 */}
        <ProjectionFormCard runtime={runtime} patient={patient} freshTapRef={freshTapRef} />
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
