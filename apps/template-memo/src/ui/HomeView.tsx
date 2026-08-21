// ホーム: 患者グリッド (タップで詳細へ / ステータス変更 / 転記用QR / 患者追加)、
// ラウンド開始 (= 記録クリア: snapshot → clear → fail-closed 保存 → rollback)。

import { useState, type CSSProperties } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { BottomActionBar } from './BottomActionBar';
import { useToast } from '@snishi/foundation/ui/toast';
import { clone } from '../domain/types';
import { applyRoundStartClear } from '../domain/clearPolicy';
import { roundStartClearTagNames } from '../domain/tags';
import { REASON, countActivePatients } from '../data/snapshots';
import { useRevision, type AppRuntime } from './appRuntime';
import {
  ensurePatientOrder,
  formatPatientLabel,
  patientLabelParts,
  roomColumnCh,
  statusClass,
  STATUS_MARK,
} from './patientDisplay';
import { DetailQrDialog } from './DetailQrDialog';
import { PatientEditPopup } from './PatientEditPopup';
import { StatusPickerPopup } from './StatusPicker';
import { TagFilterPicker } from './TagPicker';
import { patientMatchesTagFilter } from './tags';
import { OverlayBinding } from './registries';
import { ScrollTopButton } from './ScrollTopButton';
import { s } from '../i18n';
import { UI } from '../ui-contract';

export function HomeView({
  runtime,
  onOpenPatient,
}: {
  runtime: AppRuntime;
  onOpenPatient: (no: number) => void;
}) {
  const toast = useToast();
  useRevision(runtime);
  const { store } = runtime;
  const appState = store.getAppState();

  // 描画前の自動ソート (in-place・冪等。表示中は動かさない)。部屋番号順。
  ensurePatientOrder(appState.patients);

  // 番号 (位置) 列の共通幅。タグ絞り込みでは変えない — フィルタ操作のたびに
  // 列幅が揺れると行の見た目が安定しないため、表示前の全件で決める。
  const roomCol = roomColumnCh(appState.patients);

  const [clearConfirm, setClearConfirm] = useState(false);
  // 患者追加直後に開く編集ポップアップの対象 (部屋番号入力でソートされても取り違えない
  // よう index でなく pid で捕捉する — patient取り違え防止)
  const [addPid, setAddPid] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  // 患者カード右端の埋め込み QR ボタンで開く転記用 QR の対象 (pid 捕捉)
  const [qrPid, setQrPid] = useState<string | null>(null);
  // ホーム左端ステータスボタンで開くステータス変更ポップアップの対象 (pid 捕捉)
  const [statusPid, setStatusPid] = useState<string | null>(null);

  // アーカイブ一覧ビュー (終了した患者・読み取り + 復帰/完全削除)。
  const archive = store.isArchiveViewActive();

  // ラウンド開始 (= 記録クリア)。クリア対象はユーザー選択式にせず、コード固定ポリシー (design.md「クリア方針」)。
  //   クリアする: status 黄/緑/灰 → none / 場所ごとの自由本文 (sectionTexts) /
  //               今回セッション用入力値 (projectedValues) / 青以外の色のタグ。
  //   残す: status 青 (持ち越し/要注意) / 継続メモ (standingMemo) / 青のタグ / プロブレムリスト。
  // fail-closed: 保存できなければ live を戻して中断。
  async function runClear(): Promise<void> {
    setClearConfirm(false);
    const state = store.getAppState();
    await runtime.snapshots.capture(
      REASON.CLEAR,
      store.storage.getActiveWorkspaceId(),
      { title: state.title, patients: state.patients },
      String(countActivePatients(state.patients)),
    );
    const now = Date.now();
    const backup = state.patients.map((p) => clone(p));
    // タグの色 = 「ラウンド開始で外れるか」。色の解決 (settings.tags) はこの呼び出し側で行い、
    // domain のクリア方針には「外すタグ名の集合」だけを渡す。定義に無い孤児タグ名は集合に
    // 入らない = 残る (安全側)。
    const clearTagNames = roundStartClearTagNames(store.getSettings().tags);
    // クリアは固定ポリシー (clearPolicy.applyRoundStartClear)。1 箇所に集約し UI は必ずこれを通す。
    for (const p of state.patients) applyRoundStartClear(p, now, clearTagNames);
    try {
      await store.persistActiveOrThrow();
    } catch (e) {
      console.error('clear: save failed, rolling back:', e);
      // live state を破壊前へ戻す (flat store は live=master 共有のため setAppState で pid ごと差し替える)
      store.setAppState({ ...state, patients: backup });
      runtime.bump();
      toast.show(s.save.failed, 'error');
      return; // 成功表示へ進めない (fail-closed)
    }
    runtime.bump();
  }

  return (
    <section aria-label={s.header.home} className="homeView">
      <div className="viewToolbar">
        {/* ラウンド開始。テンプレート未選択でも開始できる (status 等のクリアはテンプレートに依存しない)。 */}
        <Button
          onClick={() => setClearConfirm(true)}
          title={s.home.start.tooltip}
          dataUi={UI.home.start}
        >
          {s.home.start.btn}
        </Button>
        <TagFilterPicker store={store} onChange={() => runtime.bump()} />
        <span className="viewToolbarSpacer" />
      </div>

      {archive ? <div className="banner trashBanner">{s.archive.banner}</div> : null}

      <div
        className="grid"
        data-ui={UI.home.grid}
        style={{ '--room-col': `${roomCol}ch` } as CSSProperties}
      >
        {appState.patients.map((p, idx) => {
          // タグ絞り込み (AND)。
          if (!patientMatchesTagFilter(p)) return null;
          const no = idx + 1;
          const label = formatPatientLabel(p, String(no));
          const parts = patientLabelParts(p, String(no));
          const cls = statusClass(p.status);
          return (
            <div key={p.pid} className="patientCardRow">
              {/* 左端: ステータスボタン (44px 正方)。テンプレート未選択でも status は変更できる。 */}
              {!archive ? (
                <button
                  type="button"
                  className={`patientStatusBtn ${cls || 'status-none'}`}
                  aria-label={s.home.statusBtn.aria(label)}
                  data-ui={UI.home.statusZone}
                  onClick={(e) => {
                    e.stopPropagation();
                    setStatusPid(p.pid);
                  }}
                >
                  <span aria-hidden="true">{STATUS_MARK[p.status]}</span>
                </button>
              ) : null}
              {/* 中央: 患者ボタン (部屋 + 氏名のみ)。最重要情報 = 部屋番号 + 患者名。タグのチップは
                  カードに出さない (患者シートに集約・絞り込みはタグフィルタで行う)。
                  番号と名前は別スパン (間隔は CSS の gap。半角スペース 1 個では詰まって見える
                  — 実ユーズレビュー②)。読み上げは aria-label の結合ラベルで従来どおり。 */}
              <button
                type="button"
                className={`patientBtn ${cls}`}
                aria-label={label}
                data-ui={UI.patient.card}
                onClick={() => onOpenPatient(no)}
              >
                {roomCol > 0 ? (
                  // 番号列は一覧に位置が 1 件でもあれば全行に置く (未入力行も空スパンで
                  // 列を確保し、名前の頭を縦に揃える)。幅は .grid の --room-col。
                  // スパン間の {' '} は flex レイアウトでは描画されない空白テキストノード。
                  // textContent を結合ラベル「番号 名前」と一致させる (テストの hasText・コピー時の体裁)。
                  <>
                    <span className="patientBtnRoom" data-ui={UI.patient.cardRoom}>
                      {parts.room}
                    </span>
                    {parts.room ? ' ' : null}
                  </>
                ) : null}
                <span className="patientBtnName" data-ui={UI.patient.cardName}>
                  {parts.name}
                </span>
              </button>
              {/* 右端: 埋め込み QR (ホームから直接その患者の転記用 QR を出す)。 */}
              {!archive ? (
                <button
                  type="button"
                  className="patientQrBtn"
                  title={s.home.patientQr.title}
                  aria-label={s.home.patientQr.aria(label)}
                  data-ui={UI.home.patientQr}
                  onClick={(e) => {
                    e.stopPropagation();
                    setQrPid(p.pid);
                  }}
                >
                  <Icon name="qr" size={22} />
                </button>
              ) : null}
            </div>
          );
        })}
        {archive && appState.patients.length === 0 ? (
          <p className="muted trashEmpty">{s.archive.empty}</p>
        ) : null}
        {/* 患者追加 (名前だけで確定)。作成後すぐ患者シートを開いて名前を入れる
            (部屋/プロブレム/タグは後から任意)。 */}
        {!archive ? (
          <button
            type="button"
            className="addPatientBtn"
            title={s.patient.add.title}
            aria-label={s.patient.add.aria}
            data-ui={UI.home.addPatient}
            disabled={addBusy}
            onClick={() => {
              if (addBusy) return;
              setAddBusy(true);
              void store
                .createPatientInActivePlace()
                .then((pid) => {
                  setAddPid(pid);
                  runtime.bump();
                })
                .catch((e) => {
                  console.error('patient create failed:', e);
                  toast.show(s.patient.add.failed, 'error');
                })
                .finally(() => setAddBusy(false));
            }}
          >
            <Icon name="add" size={20} />
            <span className="addPatientBtnLabel">{s.patient.add.label}</span>
          </button>
        ) : null}
      </div>

      {/* 下部固定の操作バー: [ホーム] のみ。詳細/設定と同じ意味。 */}
      <BottomActionBar
        dataUi={UI.home.actionBar}
        home={{ label: s.header.home, dataUi: UI.home.homeBottom, disabled: true }}
      />

      {clearConfirm ? <OverlayBinding onClose={() => setClearConfirm(false)} /> : null}
      {clearConfirm ? (
        <ConfirmDialog
          title={s.home.start.btn}
          body={s.home.start.confirm}
          confirmLabel={s.home.start.btn}
          cancelLabel={s.common.cancel}
          danger
          onCancel={() => setClearConfirm(false)}
          onConfirm={() => void runClear()}
        />
      ) : null}

      {qrPid != null
        ? (() => {
            // 患者は pid で引き直す (並び替えで別患者の QR を出さない)
            const target = appState.patients.find((x) => x.pid === qrPid);
            if (!target) return null;
            return (
              <DetailQrDialog
                patient={target}
                template={store.getTemplateForPatient(target)}
                settings={store.getSettings()}
                onClose={() => setQrPid(null)}
              />
            );
          })()
        : null}

      {addPid != null
        ? (() => {
            // 部屋番号入力で並びが変わるため、描画ごとに pid → 現 index を解決する
            const no = appState.patients.findIndex((p) => p.pid === addPid) + 1;
            if (no <= 0) return null;
            return (
              <PatientEditPopup patientNo={no} runtime={runtime} onClose={() => setAddPid(null)} />
            );
          })()
        : null}

      {statusPid != null
        ? (() => {
            // pid で引き直す (並び替えで別患者を操作しない)
            const target = appState.patients.find((x) => x.pid === statusPid);
            if (!target) return null;
            return (
              <StatusPickerPopup
                value={target.status}
                onSelect={(status) => {
                  target.status = status;
                  const no = appState.patients.indexOf(target) + 1;
                  store.markUpdated(no);
                  store.scheduleSave();
                  runtime.bump();
                }}
                onClose={() => setStatusPid(null)}
                dataUi={UI.patient.statusPopup}
              />
            );
          })()
        : null}
      <ScrollTopButton />
    </section>
  );
}
